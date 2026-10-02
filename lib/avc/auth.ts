import { bindings } from './storage.ts';
import { insist } from './core.ts';
export type Principal = {
    id: string;
    name: string;
    agent: boolean;
    project?: string;
    role?: string;
};
export async function digest(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(x => x.toString(16).padStart(2, '0')).join(''); }
export function token() { return 'avc_' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x => x.toString(16).padStart(2, '0')).join(''); }
export async function passwordHash(password: string, salt?: string) { const seed = salt ?? token(); const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(seed), iterations: 100000, hash: 'SHA-256' }, material, 256); return seed + ':' + Array.from(new Uint8Array(bits)).map(x => x.toString(16).padStart(2, '0')).join(''); }
export async function principal(req: Request): Promise<Principal | null> {
    const { db } = bindings();
    const auth = req.headers.get('authorization');
    let bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (auth?.startsWith('Basic ')) {
        try {
            bearer = atob(auth.slice(6)).split(':').slice(1).join(':');
        }
        catch { }
    }
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
    const user = req.headers.get('oai-authenticated-user-id');
    if (user)
        return { id: 'siwc:' + user, name: req.headers.get('oai-authenticated-user-email') ?? 'Reviewer', agent: false };
    const cookie = req.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('avc_session='))?.slice(12);
    if (!cookie)
        return null;
    const session = await db.prepare('SELECT sessions.user,users.email FROM sessions JOIN users ON users.id=sessions.user WHERE digest=? AND expires>?').bind(await digest(cookie), Date.now()).first<{
        user: string;
        email: string;
    }>();
    return session ? { id: session.user, name: session.email, agent: false } : null;
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
export async function rateLimit(req: Request, email: string) { const key = await digest((req.headers.get('cf-connecting-ip') ?? 'local') + email); const now = Date.now(); const db = bindings().db; await db.prepare('INSERT INTO auth_attempts(key,count,reset) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset<? THEN 1 ELSE count+1 END,reset=CASE WHEN reset<? THEN excluded.reset ELSE reset END').bind(key, now + 900000, now, now).run(); const r = await db.prepare('SELECT count FROM auth_attempts WHERE key=?').bind(key).first<{
    count: number;
}>(); insist((r?.count ?? 0) <= 10, 'rate_limited', 'Too many login attempts. Try again in 15 minutes.', 429); }
