import { env } from 'cloudflare:workers';
import { bindings } from './storage.ts';
import { insist, ProtocolError } from './core.ts';
import { boundedBytes } from './github-transport.ts';

export type Provider = 'github' | 'gitlab';
// Optional application configuration, like AccessEnvironment; a provider is
// disabled until all its deployment secrets and its canonical origin exist.
export type OAuthEnvironment = {
    AVC_OAUTH_ORIGIN?: string;
    AVC_GITHUB_CLIENT_ID?: string;
    AVC_GITHUB_CLIENT_SECRET?: string;
    AVC_GITLAB_CLIENT_ID?: string;
    AVC_GITLAB_CLIENT_SECRET?: string;
};
type Config = { origin: string; client: string; secret: string; authorize: string; token: string; redirect: string };
type Tokens = { access: string; refresh?: string; expires?: number };
type Connection = { id: string; user: string; provider: Provider; provider_user: string; username: string; credential: string; updated: number };
const encoder = new TextEncoder(), decoder = new TextDecoder();
export function provider(value: unknown): Provider { insist(value === 'github' || value === 'gitlab', 'invalid_provider', 'Choose GitHub or GitLab.', 400); return value; }
export async function hash(value: string) { return Buffer.from(await crypto.subtle.digest('SHA-256', encoder.encode(value))).toString('hex'); }
function random() { return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'); }
export function oauthConfig(p: Provider, settings: OAuthEnvironment = env): Config {
    const client = p === 'github' ? settings.AVC_GITHUB_CLIENT_ID : settings.AVC_GITLAB_CLIENT_ID;
    const secret = p === 'github' ? settings.AVC_GITHUB_CLIENT_SECRET : settings.AVC_GITLAB_CLIENT_SECRET;
    insist(settings.AVC_OAUTH_ORIGIN && client && secret, 'oauth_unavailable', `The deployment has not configured ${p === 'github' ? 'GitHub' : 'GitLab'} OAuth.`, 503);
    let url: URL; try { url = new URL(settings.AVC_OAUTH_ORIGIN); } catch { throw new ProtocolError('oauth_unavailable', 'OAuth canonical origin is invalid.', 503); }
    insist((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'oauth_unavailable', 'Configure an HTTPS OAuth origin without a path.', 503);
    const base = p === 'github' ? 'https://github.com/login/oauth' : 'https://gitlab.com/oauth';
    return { origin: url.origin, client, secret, authorize: base + '/authorize', token: base + (p === 'github' ? '/access_token' : '/token'), redirect: `${url.origin}/api/oauth/${p}/callback` };
}
export function configured(p: Provider) { try { oauthConfig(p); return !!env.GITHUB_SYNC_KEY; } catch { return false; } }
async function key(secret: string) {
    insist(/^[a-f0-9]{64}$/.test(secret), 'sync_credentials', 'Configure the cloud sync encryption secret first.', 503);
    return crypto.subtle.importKey('raw', Buffer.from(secret, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(value: string, context: string, secret: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await key(secret), encoder.encode(value));
    return JSON.stringify({ iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') });
}
export async function decrypt(value: string, context: string, secret: string) {
    const data = JSON.parse(value) as { iv: string; ciphertext: string };
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(data.iv, 'base64'), additionalData: encoder.encode(context) }, await key(secret), Buffer.from(data.ciphertext, 'base64')));
}
export async function sessionBinding(req: Request, access = false) {
    const cookies = (req.headers.get('cookie') ?? '').split(';').map(value => value.trim());
    const values = cookies.filter(value => value.startsWith(access ? 'CF_Authorization=' : 'avc_session='));
    const raw = access ? req.headers.get('cf-access-jwt-assertion') ?? (values.length === 1 ? values[0].slice(17) : '') : values.length === 1 ? values[0].slice(12) : '';
    insist(raw, 'oauth_session', 'Sign in again before connecting an account.', 401);
    return hash(raw);
}
export async function startOAuth(p: Provider, user: string, session: string, project: string, requestOrigin: string) {
    const config = oauthConfig(p); insist(requestOrigin === config.origin, 'origin_denied', 'OAuth must start from the configured application origin.', 403);
    const state = random(), verifier = random(), stateHash = await hash(state), db = bindings().db;
    await db.prepare('DELETE FROM oauth_states WHERE expires<?').bind(Date.now()).run();
    await db.prepare('DELETE FROM oauth_states WHERE user=? AND session=? AND provider=?').bind(user, session, p).run();
    await db.prepare('INSERT INTO oauth_states(digest,user,session,provider,project,verifier,expires) VALUES(?,?,?,?,?,?,?)').bind(stateHash, user, session, p, project, await encrypt(verifier, `oauth-state:${stateHash}:${user}:${session}`, env.GITHUB_SYNC_KEY), Date.now() + 600_000).run();
    const target = new URL(config.authorize);
    target.search = new URLSearchParams({ client_id: config.client, redirect_uri: config.redirect, response_type: 'code', scope: p === 'github' ? 'repo workflow read:org' : 'read_user read_api write_repository', state, code_challenge: Buffer.from(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))).toString('base64url'), code_challenge_method: 'S256' }).toString();
    return target.href;
}
export async function providerJSON(url: string, token?: string, init: RequestInit = {}, send: typeof fetch = fetch): Promise<unknown> {
    const parsed = new URL(url);
    insist(parsed.protocol === 'https:' && ['api.github.com', 'github.com', 'gitlab.com'].includes(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port, 'invalid_provider', 'Invalid provider endpoint.', 400);
    const response = await send(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json', 'User-Agent': 'Journey-OAuth', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
    if (!response.ok) { await response.body?.cancel(); throw new ProtocolError('provider_request', 'The provider could not complete this request. Reconnect your account or check repository permissions.', response.status === 401 || response.status === 403 ? 403 : 502); }
    try { return JSON.parse(decoder.decode(await boundedBytes(response, 2_000_000))); } catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError('provider_response', 'The provider returned an invalid response.', 502); }
}
function tokenResponse(value: unknown): Tokens {
    insist(value && typeof value === 'object' && 'access_token' in value && typeof value.access_token === 'string' && value.access_token.length >= 10 && value.access_token.length <= 2000 && !/[\s\x00-\x1f\x7f]/.test(value.access_token), 'oauth_exchange', 'The provider did not authorize this connection.', 400);
    const data = value as { access_token: string; token_type?: unknown; refresh_token?: unknown; expires_in?: unknown };
    insist(data.token_type === undefined || String(data.token_type).toLowerCase() === 'bearer', 'oauth_exchange', 'The provider returned an unsupported token.', 502);
    const result: Tokens = { access: data.access_token };
    if (typeof data.refresh_token === 'string' && data.refresh_token.length <= 2000) result.refresh = data.refresh_token;
    if (typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0) result.expires = Date.now() + data.expires_in * 1000;
    return result;
}
async function exchange(p: Provider, grant: Record<string, string>) {
    const config = oauthConfig(p);
    return tokenResponse(await providerJSON(config.token, undefined, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.client, client_secret: config.secret, ...grant }).toString() }));
}
export async function consumeState(p: Provider, state: string, user: string, session: string) {
    insist(/^[A-Za-z0-9_-]{43}$/.test(state), 'oauth_state', 'This account connection expired or was already used. Start again.', 400);
    const digest = await hash(state);
    // DELETE RETURNING is one statement: concurrent callbacks cannot both redeem.
    const row = await bindings().db.prepare('DELETE FROM oauth_states WHERE digest=? AND user=? AND session=? AND provider=? AND expires>? RETURNING project,verifier').bind(digest, user, session, p, Date.now()).first<{ project: string; verifier: string }>();
    insist(row, 'oauth_state', 'This account connection expired or was already used. Start again.', 400);
    return { project: row.project, verifier: await decrypt(row.verifier, `oauth-state:${digest}:${user}:${session}`, env.GITHUB_SYNC_KEY) };
}
export async function completeOAuth(p: Provider, user: string, code: string, verifier: string) {
    insist(code.length > 0 && code.length <= 2000, 'oauth_code', 'The provider did not supply an authorization code.', 400);
    const tokens = await exchange(p, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: oauthConfig(p).redirect });
    const info = await providerJSON(p === 'github' ? 'https://api.github.com/user' : 'https://gitlab.com/api/v4/user', tokens.access);
    insist(info && typeof info === 'object' && 'id' in info && (typeof info.id === 'number' || typeof info.id === 'string'), 'oauth_identity', 'Provider identity could not be verified.', 502);
    const username = p === 'github' && 'login' in info ? info.login : 'username' in info ? info.username : undefined;
    insist(typeof username === 'string' && username.length <= 255, 'oauth_identity', 'Provider identity could not be verified.', 502);
    const id = await hash(`${user}:${p}`), credential = await encrypt(JSON.stringify(tokens), `oauth-connection:${id}:${user}:${p}`, env.GITHUB_SYNC_KEY);
    await bindings().db.prepare('INSERT INTO oauth_connections(id,user,provider,provider_user,username,credential,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user,provider) DO UPDATE SET provider_user=excluded.provider_user,username=excluded.username,credential=excluded.credential,updated=excluded.updated,refresh_lock=NULL,refresh_until=NULL').bind(id, user, p, String(info.id), username, credential, Date.now()).run();
    return { provider: p, username };
}
export async function connection(user: string, p: Provider) { return bindings().db.prepare('SELECT id,user,provider,provider_user,username,credential,updated FROM oauth_connections WHERE user=? AND provider=?').bind(user, p).first<Connection>(); }
export async function connectionToken(user: string, p: Provider, secret = env.GITHUB_SYNC_KEY) {
    const row = await connection(user, p); insist(row, 'oauth_required', `Connect your ${p === 'github' ? 'GitHub' : 'GitLab'} account first.`, 409);
    const context = `oauth-connection:${row.id}:${user}:${p}`, tokens = JSON.parse(await decrypt(row.credential, context, secret)) as Tokens;
    if (!tokens.expires || tokens.expires > Date.now() + 120_000) return tokens.access;
    insist(tokens.refresh, 'oauth_expired', 'Your provider connection expired. Reconnect the account.', 409);
    const lease = random(), db = bindings().db;
    const claimed = await db.prepare('UPDATE oauth_connections SET refresh_lock=?,refresh_until=? WHERE id=? AND credential=? AND (refresh_until IS NULL OR refresh_until<?)').bind(lease, Date.now() + 60_000, row.id, row.credential, Date.now()).run();
    insist(claimed.meta.changes === 1, 'oauth_refreshing', 'This account connection is refreshing. Retry shortly.', 409);
    try {
        const next = await exchange(p, { grant_type: 'refresh_token', refresh_token: tokens.refresh });
        next.refresh ??= tokens.refresh;
        const stored = await db.prepare('UPDATE oauth_connections SET credential=?,updated=?,refresh_lock=NULL,refresh_until=NULL WHERE id=? AND credential=? AND refresh_lock=?').bind(await encrypt(JSON.stringify(next), context, secret), Date.now(), row.id, row.credential, lease).run();
        insist(stored.meta.changes === 1, 'oauth_changed', 'The provider connection changed. Retry.', 409);
        return next.access;
    } finally { await db.prepare('UPDATE oauth_connections SET refresh_lock=NULL,refresh_until=NULL WHERE id=? AND refresh_lock=?').bind(row.id, lease).run(); }
}
export type ProviderRepository = { id: string; name: string; remote: string; branch: string; private: boolean };
export async function repositories(user: string, p: Provider, page = 1, owner?: string): Promise<{ repositories: ProviderRepository[]; nextPage: number | null }> {
    insist(Number.isInteger(page) && page >= 1 && page <= 1000, 'invalid_page', 'Invalid repository page.', 400);
    const token = await connectionToken(user, p);
    let githubURL = '';
    if (p === 'github') {
        const account = await connection(user, p);
        owner ??= account!.username;
        insist(validGitHubLogin(owner), 'invalid_owner', 'Select a GitHub organization or personal account.', 400);
        if (owner.toLowerCase() === account!.username.toLowerCase()) {
            githubURL = `https://api.github.com/user/repos?affiliation=owner&per_page=100&page=${page}&sort=updated`;
        } else {
            const membership = await providerJSON(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(owner)}`, token);
            insist(membership && typeof membership === 'object' && 'state' in membership && membership.state === 'active', 'invalid_owner', 'Select an organization you belong to. Reconnect GitHub if organization access has changed.', 403);
            githubURL = `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos?type=all&per_page=100&page=${page}&sort=updated`;
        }
    }
    const data = await providerJSON(p === 'github' ? githubURL : `https://gitlab.com/api/v4/projects?owned=true&min_access_level=30&per_page=100&page=${page}&order_by=last_activity_at`, token);
    insist(Array.isArray(data), 'provider_response', 'The provider returned an invalid repository list.', 502);
    const result = data.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        if (p === 'github') {
            if (!['User', 'Organization'].includes(value.owner?.type) || typeof value.owner?.login !== 'string' || value.owner.login.toLowerCase() !== owner!.toLowerCase() || value.permissions?.push !== true || value.archived || value.disabled) return [];
            return [{ id: String(value.id), name: String(value.full_name), remote: String(value.clone_url), branch: String(value.default_branch || 'main'), private: value.private === true }];
        }
        if (value.namespace?.kind !== 'user' || value.archived || value.marked_for_deletion_on) return [];
        return [{ id: String(value.id), name: String(value.path_with_namespace), remote: String(value.http_url_to_repo), branch: String(value.default_branch || 'main'), private: value.visibility !== 'public' }];
    });
    return { repositories: result, nextPage: data.length === 100 && page < 1000 ? page + 1 : null };
}

export type GitHubOwner = { login: string; kind: 'personal' | 'organization' };
function validGitHubLogin(value: string) { return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value); }
export async function githubOwners(user: string, page = 1): Promise<{ owners: GitHubOwner[]; nextOwnerPage: number | null }> {
    insist(Number.isInteger(page) && page >= 1 && page <= 1000, 'invalid_page', 'Invalid organization page.', 400);
    const token = await connectionToken(user, 'github'), account = await connection(user, 'github');
    const data = await providerJSON(`https://api.github.com/user/orgs?per_page=100&page=${page}`, token);
    insist(Array.isArray(data), 'provider_response', 'GitHub returned an invalid organization list.', 502);
    const owners: GitHubOwner[] = page === 1 ? [{ login: account!.username, kind: 'personal' }] : [];
    for (const value of data) {
        if (value && typeof value.login === 'string' && validGitHubLogin(value.login)) owners.push({ login: value.login, kind: 'organization' });
    }
    return { owners, nextOwnerPage: data.length === 100 && page < 1000 ? page + 1 : null };
}
