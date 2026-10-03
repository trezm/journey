/** Optional, deployment-specific Cloudflare Access owner authentication. */
export type AccessEnvironment = {
    AVC_ACCESS_TEAM_DOMAIN?: string;
    AVC_ACCESS_AUD?: string;
    /** Private JSON object mapping a verified Access email to an existing owner ID. */
    AVC_ACCESS_OWNER_MAP?: string;
};
export type AccessOwner = { id: string; name: string; agent: false };
export type AccessFailureReason = 'configuration_invalid' | 'token_missing' | 'token_format_invalid' | 'jwt_header_invalid' | 'signing_keys_unavailable' | 'signature_invalid' | 'identity_claims_invalid' | 'audience_denied' | 'time_claims_invalid' | 'owner_unmapped' | 'verification_exception';
export type AccessSigningKeyFailure = 'none' | 'fetch_failed' | 'http_error' | 'response_invalid' | 'key_import_failed' | 'key_missing' | 'refresh_throttled' | 'timeout' | 'capacity';
/** Fixed diagnostic fields only; never include token, claim, identity or error values. */
export type AccessDiagnostic = {
    event: 'access_denied';
    reason: AccessFailureReason;
    signingKeyFailure: AccessSigningKeyFailure;
    assertionPresent: boolean;
    authorizationCookiePresent: boolean;
    authorizationCookieUnambiguous: boolean;
    typPresent: boolean;
    typValid: boolean;
    typePresent: boolean;
    typeValid: boolean;
    nbfPresent: boolean;
    nbfValid: boolean;
};
type Configuration = { issuer: string; audience: string; owners: Map<string, string> };
type CachedKeys = { keys: Map<string, CryptoKey>; fetched: number };
class SigningKeyFailure extends Error {
    readonly stage: Exclude<AccessSigningKeyFailure, 'none'>;
    constructor(stage: Exclude<AccessSigningKeyFailure, 'none'>) { super('Access signing key unavailable.'); this.stage = stage; }
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_TOKEN_BYTES = 16384, MAX_JWKS_BYTES = 65536;
const KEY_TTL = 600000, REFRESH_INTERVAL = 30000, FETCH_TIMEOUT = 8000;

export function accessEnabled(env: AccessEnvironment): boolean {
    // Partial configuration must not silently re-enable password authentication.
    return [env.AVC_ACCESS_TEAM_DOMAIN, env.AVC_ACCESS_AUD, env.AVC_ACCESS_OWNER_MAP].some(value => value !== undefined);
}
function configuration(env: AccessEnvironment): Configuration {
    const domain = env.AVC_ACCESS_TEAM_DOMAIN;
    if (!domain || !env.AVC_ACCESS_AUD || !env.AVC_ACCESS_OWNER_MAP || env.AVC_ACCESS_OWNER_MAP.length > MAX_JWKS_BYTES) throw new Error('Incomplete Access configuration.');
    const issuer = new URL(domain.startsWith('https://') ? domain : 'https://' + domain);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.port || issuer.search || issuer.hash || issuer.pathname !== '/' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer.hostname)) throw new Error('Invalid Access issuer.');
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(env.AVC_ACCESS_AUD)) throw new Error('Invalid Access audience.');
    const mapping = JSON.parse(env.AVC_ACCESS_OWNER_MAP) as unknown;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid Access owner mapping.');
    const entries = Object.entries(mapping);
    if (!entries.length || entries.length > 100) throw new Error('Invalid Access owner mapping.');
    const owners = new Map<string, string>();
    for (const [email, id] of entries) {
        const normalized = email.toLowerCase();
        if (email !== email.trim() || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || owners.has(normalized) || typeof id !== 'string' || !id || id.length > 255 || id !== id.trim() || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Invalid Access owner mapping.');
        owners.set(normalized, id);
    }
    return { issuer: issuer.origin, audience: env.AVC_ACCESS_AUD, owners };
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid JWT encoding.');
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
function json(value: string): Record<string, unknown> {
    const parsed = JSON.parse(decoder.decode(bytes(value))) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JWT claims.');
    return parsed as Record<string, unknown>;
}
function requestToken(request: Request): string | undefined {
    const header = request.headers.get('Cf-Access-Jwt-Assertion');
    if (header !== null) return header;
    // Bypassed API paths may not receive an injected assertion header. A cookie
    // is still untrusted input and receives the identical signature/claim checks.
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('CF_Authorization='));
    if (cookies.length !== 1) return undefined;
    return cookies[0].slice('CF_Authorization='.length);
}
async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
    const size = response.headers.get('content-length');
    if (size && (!/^\d+$/.test(size) || Number(size) > MAX_JWKS_BYTES)) throw new Error('Invalid Access key response.');
    if (!response.ok || !response.body) throw new Error('Access keys unavailable.');
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_JWKS_BYTES) throw new Error('Access key response too large.');
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
    signal.throwIfAborted();
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(decoder.decode(data));
}

export class AccessVerifier {
    private fetcher: typeof fetch;
    private clock: () => number;
    private diagnostic?: (diagnostic: Readonly<AccessDiagnostic>) => void;
    private cache = new Map<string, CachedKeys>();
    private refreshing = new Map<string, Promise<CachedKeys>>();
    private attempted = new Map<string, number>();
    constructor(options: { fetch?: typeof fetch; now?: () => number; diagnostic?: (diagnostic: Readonly<AccessDiagnostic>) => void } = {}) {
        this.fetcher = options.fetch ?? ((...args) => fetch(...args));
        this.clock = options.now ?? Date.now;
        this.diagnostic = options.diagnostic;
    }
    private async refresh(issuer: string): Promise<CachedKeys> {
        const running = this.refreshing.get(issuer);
        if (running) return running;
        if (this.refreshing.size >= 4) throw new SigningKeyFailure('capacity');
        const now = this.clock(), previous = this.attempted.get(issuer);
        if (previous !== undefined && now - previous < REFRESH_INTERVAL) throw new SigningKeyFailure('refresh_throttled');
        this.attempted.set(issuer, now);
        // A deployment uses one issuer; keep even invalid configuration changes bounded.
        if (this.attempted.size > 4) {
            const oldest = this.attempted.keys().next().value!;
            this.attempted.delete(oldest); this.cache.delete(oldest);
        }
        const promise = (async () => {
            const controller = new AbortController();
            let timeout: ReturnType<typeof setTimeout>;
            const expired = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new SigningKeyFailure('timeout')); }, FETCH_TIMEOUT); });
            const operation = (async () => {
                let response: Response;
                // Pinned Workerd 1.20260515.1 rejects redirect: 'error'. Manual
                // returns redirects without following them; !response.ok denies them.
                try { response = await this.fetcher(issuer + '/cdn-cgi/access/certs', { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } }); }
                catch { throw new SigningKeyFailure(controller.signal.aborted ? 'timeout' : 'fetch_failed'); }
                if (!response.ok) throw new SigningKeyFailure('http_error');
                let data: { keys?: unknown };
                try { data = await boundedJSON(response, controller.signal) as { keys?: unknown }; }
                catch { throw new SigningKeyFailure(controller.signal.aborted ? 'timeout' : 'response_invalid'); }
                if (!data || !Array.isArray(data.keys) || !data.keys.length || data.keys.length > 32) throw new SigningKeyFailure('response_invalid');
                const keys = new Map<string, CryptoKey>();
                for (const candidate of data.keys) {
                    if (!candidate || typeof candidate !== 'object') throw new SigningKeyFailure('response_invalid');
                    const key = candidate as Record<string, unknown>;
                    if (typeof key.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid) || keys.has(key.kid)) throw new SigningKeyFailure('response_invalid');
                    if (key.kty !== 'RSA' || (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig') || typeof key.n !== 'string' || typeof key.e !== 'string') throw new SigningKeyFailure('response_invalid');
                    const modulus = bytes(key.n), exponent = bytes(key.e);
                    if (modulus.length < 256 || modulus.length > 1024 || exponent.length > 8) throw new SigningKeyFailure('response_invalid');
                    let imported: CryptoKey;
                    try { imported = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); }
                    catch { throw new SigningKeyFailure('key_import_failed'); }
                    keys.set(key.kid, imported);
                }
                controller.signal.throwIfAborted();
                const result = { keys, fetched: this.clock() };
                this.cache.set(issuer, result);
                if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
                return result;
            })();
            try { return await Promise.race([operation, expired]); }
            finally { clearTimeout(timeout!); }
        })();
        this.refreshing.set(issuer, promise);
        try { return await promise; }
        finally { this.refreshing.delete(issuer); }
    }
    private async key(issuer: string, kid: string): Promise<CryptoKey> {
        let cached = this.cache.get(issuer);
        if (!cached || this.clock() - cached.fetched >= KEY_TTL || !cached.keys.has(kid)) cached = await this.refresh(issuer);
        const key = cached.keys.get(kid);
        if (!key) throw new SigningKeyFailure('key_missing');
        return key;
    }
    async principal(request: Request, env: AccessEnvironment): Promise<AccessOwner | null> {
        const fields: Omit<AccessDiagnostic, 'event' | 'reason'> = {
            signingKeyFailure: 'none',
            assertionPresent: false, authorizationCookiePresent: false, authorizationCookieUnambiguous: false,
            typPresent: false, typValid: false, typePresent: false, typeValid: false, nbfPresent: false, nbfValid: false,
        };
        const deny = (reason: AccessFailureReason): null => {
            // A diagnostic sink must never change an authentication decision.
            try { void Promise.resolve(this.diagnostic?.(Object.freeze({ event: 'access_denied', reason, ...fields }))).catch(() => {}); } catch { }
            return null;
        };
        try {
            fields.assertionPresent = request.headers.has('Cf-Access-Jwt-Assertion');
            const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('CF_Authorization='));
            fields.authorizationCookiePresent = cookies.length > 0;
            fields.authorizationCookieUnambiguous = cookies.length === 1;
            let config: Configuration;
            try { config = configuration(env); } catch { return deny('configuration_invalid'); }
            const token = requestToken(request);
            if (!token) return deny('token_missing');
            if (token.length > MAX_TOKEN_BYTES) return deny('token_format_invalid');
            const parts = token.split('.');
            if (parts.length !== 3) return deny('token_format_invalid');
            let header: Record<string, unknown>, claims: Record<string, unknown>, signature: Uint8Array<ArrayBuffer>;
            try { header = json(parts[0]); claims = json(parts[1]); signature = bytes(parts[2]); } catch { return deny('token_format_invalid'); }
            // RFC 7519 section 5.1 makes typ optional. Cloudflare may omit it;
            // a supplied label must still be JWT, and all cryptographic checks apply.
            fields.typPresent = Object.hasOwn(header, 'typ'); fields.typValid = !fields.typPresent || header.typ === 'JWT';
            fields.typePresent = Object.hasOwn(claims, 'type'); fields.typeValid = claims.type === 'app';
            fields.nbfPresent = Object.hasOwn(claims, 'nbf'); fields.nbfValid = typeof claims.nbf === 'number' && Number.isSafeInteger(claims.nbf) && claims.nbf >= 0;
            if (header.alg !== 'RS256' || !fields.typValid || typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid) || ['crit', 'b64', 'jku', 'jwk', 'x5u'].some(field => Object.hasOwn(header, field))) return deny('jwt_header_invalid');
            if (signature.byteLength < 256 || signature.byteLength > 1024) return deny('signature_invalid');
            let key: CryptoKey;
            try { key = await this.key(config.issuer, header.kid); }
            catch (error) { fields.signingKeyFailure = error instanceof SigningKeyFailure ? error.stage : 'response_invalid'; return deny('signing_keys_unavailable'); }
            if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, encoder.encode(parts[0] + '.' + parts[1]))) return deny('signature_invalid');
            const now = this.clock() / 1000;
            if (claims.iss !== config.issuer || claims.type !== 'app' || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || typeof claims.email !== 'string' || claims.email.length > 254) return deny('identity_claims_invalid');
            const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
            if (!audiences.length || audiences.length > 8 || !audiences.every(audience => typeof audience === 'string') || !audiences.includes(config.audience)) return deny('audience_denied');
            if (![claims.exp, claims.iat, claims.nbf].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return deny('time_claims_invalid');
            const exp = claims.exp as number, iat = claims.iat as number, nbf = claims.nbf as number;
            if (exp <= now || iat > now + 5 || nbf > now + 5 || exp <= iat || exp <= nbf) return deny('time_claims_invalid');
            const id = config.owners.get(claims.email.toLowerCase());
            return id ? { id, name: claims.email, agent: false } : deny('owner_unmapped');
        } catch { return deny('verification_exception'); }
    }
}
// Enum-bounded suppression avoids flooding production logs with repeated denials.
const diagnosticTimes = new Map<AccessFailureReason, number>();
const verifier = new AccessVerifier({ diagnostic: diagnostic => {
    const now = Date.now(), previous = diagnosticTimes.get(diagnostic.reason);
    if (previous !== undefined && now - previous < REFRESH_INTERVAL) return;
    diagnosticTimes.set(diagnostic.reason, now);
    console.warn(JSON.stringify(diagnostic));
} });
export const accessPrincipal = (request: Request, env: AccessEnvironment) => verifier.principal(request, env);
