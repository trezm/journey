import { bindings } from '@/lib/avc/storage';
import { digest, passwordHash, verifyPassword, token, principal, sameOrigin, rateLimit, authenticationMode, sessionToken } from '@/lib/avc/auth';
import { insist, ProtocolError } from '@/lib/avc/core';

type Account = { id: string; username: string; email: string; password: string };
const headers = { 'Cache-Control': 'no-store' };
const sessionLifetime = 604800;
function cookie(req: Request, value: string, age = sessionLifetime) {
    return `avc_session=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${age}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function publicAccount(user: Account) { return { id: user.id, name: user.username, username: user.username, email: user.email, agent: false }; }
async function requestBody(req: Request): Promise<Record<string, unknown>> {
    insist(req.body, 'invalid_request', 'Send an authentication request.', 400);
    const reader = req.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            insist(size <= 4096, 'request_too_large', 'Authentication request is too large.', 413);
            chunks.push(part.value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ProtocolError('invalid_request', 'Send a valid JSON object.', 400); }
    insist(body && typeof body === 'object' && !Array.isArray(body), 'invalid_request', 'Send a valid JSON object.', 400);
    return body as Record<string, unknown>;
}
export async function GET(req: Request) {
    try { return Response.json({ user: await principal(req), mode: authenticationMode() }, { headers }); }
    catch { return Response.json({ user: null, mode: authenticationMode() }, { headers }); }
}
export async function POST(req: Request) {
    try {
        sameOrigin(req);
        const body = await requestBody(req);
        const { action, password } = body;
        insist(action === 'register' || action === 'login' || action === 'logout', 'invalid_action', 'Unknown authentication action.', 400);
        if (authenticationMode() === 'access') {
            insist(action === 'logout', 'access_authentication_required', 'Sign in through Cloudflare Access.', 403);
            return Response.json({ ok: true, logoutUrl: '/cdn-cgi/access/logout' }, { headers });
        }
        const db = bindings().db, previous = sessionToken(req);
        if (action === 'logout') {
            if (previous) await db.prepare('DELETE FROM sessions WHERE digest=?').bind(await digest(previous)).run();
            return Response.json({ ok: true }, { headers: { ...headers, 'Set-Cookie': cookie(req, '', 0) } });
        }
        insist(typeof password === 'string' && password.length >= 12 && password.length <= 256, 'invalid_credentials', 'Use a password of 12–256 characters.', 400);
        let user: Account | null;
        if (action === 'register') {
            const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
            const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
            insist(/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username), 'invalid_username', 'Use a username of 3–32 letters, numbers, underscores or hyphens, starting with a letter or number.', 400);
            insist(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'invalid_email', 'Use a valid email address.', 400);
            await rateLimit(req, email);
            user = { id: crypto.randomUUID(), username, email, password: await passwordHash(password) };
            try {
                await db.prepare('INSERT INTO users(id,username,email,password) VALUES(?,?,?,?)').bind(user.id, username, email, user.password).run();
            } catch (error) {
                // Unique constraints arbitrate concurrent registrations. Do not
                // expose raw database errors or treat failed writes as success.
                const existing = await db.prepare('SELECT username,email FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE').bind(username, email).all<{ username: string; email: string }>();
                insist(!existing.results.some(row => row.username.toLowerCase() === username), 'username_exists', 'That username is already taken.', 409);
                insist(!existing.results.some(row => row.email.toLowerCase() === email), 'email_exists', 'An account already exists for that email.', 409);
                throw error;
            }
        } else {
            // Keep the existing email field usable for clients already deployed.
            const input = body.identifier ?? body.email;
            const identifier = typeof input === 'string' ? input.trim().toLowerCase() : '';
            insist(identifier.length >= 3 && identifier.length <= 254, 'invalid_credentials', 'Enter your username or email and password.', 400);
            user = await db.prepare('SELECT id,username,email,password FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE').bind(identifier, identifier).first<Account>();
            await rateLimit(req, user?.id ?? identifier);
            const verified = await verifyPassword(password, user?.password);
            insist(user && verified, 'invalid_credentials', 'Username, email or password is incorrect.', 401);
        }
        const raw = token(), now = Date.now();
        const writes = [db.prepare('INSERT INTO sessions(digest,user,expires) VALUES(?,?,?)').bind(await digest(raw), user.id, now + sessionLifetime * 1000)];
        if (previous) writes.push(db.prepare('DELETE FROM sessions WHERE digest=?').bind(await digest(previous)));
        writes.push(db.prepare('DELETE FROM sessions WHERE user=? AND expires<=?').bind(user.id, now));
        await db.batch(writes);
        return Response.json({ ok: true, user: publicAccount(user) }, { headers: { ...headers, 'Set-Cookie': cookie(req, raw) } });
    } catch (error) {
        const failure = error instanceof ProtocolError ? error : new ProtocolError('authentication_unavailable', 'Authentication is unavailable. Try again shortly.', 503);
        return Response.json({ error: failure.message, code: failure.code }, { status: failure.status, headers });
    }
}
