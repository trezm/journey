import { timingSafeEqual } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { accessEnabled, accessPrincipal, type AccessEnvironment } from './access.ts';
import { bindings } from './storage.ts';
import { insist } from './core.ts';
export type Principal = {
    id: string;
    name: string;
    agent: boolean;
    username?: string;
    email?: string;
    project?: string;
    role?: string;
};
export async function digest(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(x => x.toString(16).padStart(2, '0')).join(''); }
export function token() { return 'avc_' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x => x.toString(16).padStart(2, '0')).join(''); }
export async function passwordHash(password: string, salt?: string) { const seed = salt ?? token(); const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(seed), iterations: 100000, hash: 'SHA-256' }, material, 256); return seed + ':' + Array.from(new Uint8Array(bits)).map(x => x.toString(16).padStart(2, '0')).join(''); }
export async function verifyPassword(password: string, stored?: string): Promise<boolean> {
    // Unknown accounts still pay for one PBKDF2 derivation. Compare equal-length
    // digests using the runtime's constant-time primitive, never string equality.
    const parts = stored?.split(':');
    const valid = parts?.length === 2 && /^[a-f0-9]{64}$/.test(parts[1]);
    const derived = await passwordHash(password, valid ? parts[0] : 'unknown-account-salt');
    const actual = new TextEncoder().encode(derived.slice(derived.lastIndexOf(':') + 1));
    const expected = new TextEncoder().encode(valid ? parts[1] : '0'.repeat(64));
    return timingSafeEqual(actual, expected) && !!valid;
}
export function authenticationMode(): 'password' | 'access' {
    const settings = env as typeof env & AccessEnvironment & { AVC_AUTH_MODE?: string };
    if (settings.AVC_AUTH_MODE === 'password') return 'password';
    // Invalid explicit modes fail closed as Access deployments do. An omitted
    // mode preserves existing Access installations, including partial config.
    if (settings.AVC_AUTH_MODE !== undefined) return 'access';
    return accessEnabled(settings) ? 'access' : 'password';
}
export function sessionToken(req: Request): string | undefined {
    const values = (req.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith('avc_session='));
    return values.length === 1 ? values[0].slice('avc_session='.length) || undefined : undefined;
}
export async function principal(req: Request): Promise<Principal | null> {
    const { db } = bindings();
    const auth = req.headers.get('authorization');
    const repositoryAuth = /^(Bearer|Basic)(?:\s|$)/i.exec(auth ?? '');
    let bearer: string | undefined;
    if (repositoryAuth?.[1].toLowerCase() === 'bearer')
        bearer = auth!.slice(repositoryAuth[1].length).trim();
    if (repositoryAuth?.[1].toLowerCase() === 'basic') {
        try {
            const decoded = atob(auth!.slice(repositoryAuth[1].length).trim()), colon = decoded.indexOf(':');
            if (colon >= 0) bearer = decoded.slice(colon + 1);
        } catch { }
    }
    // An explicit failed repository credential cannot become a human identity.
    if (repositoryAuth && !bearer) return null;
    if (bearer) {
        const hash = await digest(bearer);
        const a = await db.prepare('SELECT project,name,role FROM agents WHERE digest=?').bind(hash).first<{
            project: string;
            role: string;
            name: string;
        }>();
        if (a)
            return { id: 'agent:' + hash.slice(0, 16), name: a.name, agent: true, project: a.project, role: a.role };
        return null;
    }
    if (authenticationMode() === 'access')
        return accessPrincipal(req, env as typeof env & AccessEnvironment);
    // Forwarded identity headers never authenticate. Outside Access deployments,
    // human authentication remains the existing D1 application session.
    const cookie = sessionToken(req);
    if (!cookie)
        return null;
    const session = await db.prepare('SELECT sessions.user,users.email,users.username FROM sessions JOIN users ON users.id=sessions.user WHERE digest=? AND expires>?').bind(await digest(cookie), Date.now()).first<{
        user: string;
        email: string;
        username: string;
    }>();
    return session ? { id: session.user, name: session.username, username: session.username, email: session.email, agent: false } : null;
}
export function sameOrigin(req: Request) { const origin = req.headers.get('origin'); insist(!origin || origin === new URL(req.url).origin, 'origin_denied', 'Cross-origin mutations are not allowed.', 403); }
export async function authorize(req: Request, project?: string) { const p = await principal(req); insist(p, 'unauthorized', 'Sign in or provide a repository agent token.', 401); if (project) {
    if (p.agent)
        insist(p.project === project, 'forbidden', 'Token is scoped to another repository.', 403);
    else {
        const row = await bindings().db.prepare('SELECT owner FROM projects WHERE id=?').bind(project).first<{
            owner: string;
        }>();
        insist(row?.owner === p.id, 'forbidden', 'This repository belongs to another account.', 403);
    }
} return p; }
export async function rateLimit(req: Request, identity: string) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'local';
    const now = Date.now(), db = bindings().db;
    // Limit IP spraying as well as per-account attempts. Login resolves aliases
    // to the same user ID first, so username/email cannot double the allowance.
    for (const [scope, maximum] of [[`ip:${ip}`, 60], [`account:${identity}`, 20], [`pair:${ip}:${identity}`, 10]] as const) {
        const key = await digest(scope);
        const result = await db.prepare('INSERT INTO auth_attempts(key,count,reset) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset<=? THEN 1 ELSE count+1 END,reset=CASE WHEN reset<=? THEN excluded.reset ELSE reset END RETURNING count').bind(key, now + 900000, now, now).first<{ count: number }>();
        insist(result && result.count <= maximum, 'rate_limited', 'Too many authentication attempts. Try again in 15 minutes.', 429);
    }
}
