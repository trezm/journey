import { bindings } from '@/lib/avc/storage';
import { digest, passwordHash, token, principal, sameOrigin, rateLimit, authenticationMode } from '@/lib/avc/auth';
import { insist, ProtocolError } from '@/lib/avc/core';
export async function GET(req: Request) { try {
    return Response.json({ user: await principal(req), mode: authenticationMode() }, { headers: { 'Cache-Control': 'no-store' } });
}
catch {
    return Response.json({ user: null, mode: authenticationMode() }, { headers: { 'Cache-Control': 'no-store' } });
} }
export async function POST(req: Request) {
    try {
        sameOrigin(req);
        const { action, email, password } = await req.json() as {
            action: string;
            email: string;
            password: string;
        };
        if (authenticationMode() === 'access') {
            insist(action === 'logout', 'access_authentication_required', 'Sign in through Cloudflare Access.', 403);
            return Response.json({ ok: true, logoutUrl: '/cdn-cgi/access/logout' }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const db = bindings().db;
        if (action === 'logout') {
            const raw = req.headers.get('cookie')?.match(/avc_session=([^;]+)/)?.[1];
            if (raw)
                await db.prepare('DELETE FROM sessions WHERE digest=?').bind(await digest(raw)).run();
            return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'avc_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0; Secure' } });
        }
        insist(typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 && typeof password === 'string' && password.length >= 12 && password.length <= 256, 'invalid_credentials', 'Use a valid email and a password of 12–256 characters.', 400);
        const normalized = email.toLowerCase();
        await rateLimit(req, normalized);
        let user = await db.prepare('SELECT id,password FROM users WHERE email=?').bind(normalized).first<{
            id: string;
            password: string;
        }>();
        if (action === 'register') {
            insist(!user, 'email_exists', 'An account already exists for that email.', 409);
            user = { id: crypto.randomUUID(), password: await passwordHash(password) };
            await db.prepare('INSERT INTO users(id,email,password) VALUES(?,?,?)').bind(user.id, normalized, user.password).run();
        }
        else {
            insist(action === 'login', 'invalid_action', 'Unknown authentication action.', 400);
            const expected = await passwordHash(password, user?.password.split(':')[0] ?? 'unknown-salt');
            insist(user && expected === user.password, 'invalid_credentials', 'Email or password is incorrect.', 401);
        }
        const raw = token();
        await db.prepare('INSERT INTO sessions(digest,user,expires) VALUES(?,?,?)').bind(await digest(raw), user.id, Date.now() + 604800000).run();
        return Response.json({ ok: true }, { headers: { 'Set-Cookie': `avc_session=${raw}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}` } });
    }
    catch (e) {
        const p = e as ProtocolError;
        return Response.json({ error: p.message, code: p.code }, { status: p.status ?? 500 });
    }
}
