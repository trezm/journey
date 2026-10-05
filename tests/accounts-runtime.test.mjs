import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pbkdf2Sync, createHash } from 'node:crypto';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Miniflare, Log, LogLevel } = createRequire(require.resolve('wrangler/package.json'))('miniflare');
const ts = require('typescript');
const deployment = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
function compiled(path) { return ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText; }
const access = compiled('lib/avc/access.ts').replace(/^export /gm, '');
const auth = compiled('lib/avc/auth.ts').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const route = compiled('app/api/auth/route.ts').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const script = `import { env } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
class ProtocolError extends Error { constructor(code,message,status=409) { super(message); this.code=code; this.status=status; } }
function insist(value,code,message,status) { if (!value) throw new ProtocolError(code,message,status); }
function bindings() { return { db:env.DB }; }
${access}\n${auth}\n${route}
export default { fetch(req) { return req.method==='GET' ? GET(req) : POST(req); } };`;
const hash = value => createHash('sha256').update(value).digest('hex');
const legacyPassword = 'legacy-password-2026';
const legacyHash = 'legacy-salt:' + pbkdf2Sync(legacyPassword, 'legacy-salt', 100000, 32, 'sha256').toString('hex');

async function fixture(mode = 'password') {
    const mf = new Miniflare({ modules: true, script, compatibilityDate: deployment.compatibility_date, compatibilityFlags: deployment.compatibility_flags, bindings: { AVC_AUTH_MODE: mode, AVC_ACCESS_TEAM_DOMAIN: 'legacy.cloudflareaccess.com' }, d1Databases: ['DB'], log: new Log(LogLevel.NONE), outboundService: () => new Response(null, { status: 503 }) });
    const db = await mf.getD1Database('DB');
    async function migration(name) {
        const statements = readFileSync(new URL('../drizzle/' + name + '.sql', import.meta.url), 'utf8').split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean);
        for (const statement of statements) await db.prepare(statement).run();
    }
    for (const name of ['0000_right_psynapse', '0001_majestic_captain_universe', '0002_volatile_exiles']) await migration(name);
    await db.prepare('INSERT INTO users(id,email,password) VALUES(?,?,?)').bind('legacy-one', 'legacy@example.test', legacyHash).run();
    await db.prepare('INSERT INTO users(id,email,password) VALUES(?,?,?)').bind('legacy-two', 'second@example.test', legacyHash).run();
    await db.prepare('INSERT INTO sessions(digest,user,expires) VALUES(?,?,?)').bind(hash('old-session'), 'legacy-one', Date.now() + 3600000).run();
    await db.prepare('INSERT INTO projects(id,owner,name,state) VALUES(?,?,?,?)').bind('old-repo', 'legacy-one', 'legacy repo', '{}').run();
    await migration('0003_accounts');
    const call = (body, { cookie, origin = 'https://journey.example.test', ip = '192.0.2.1', raw } = {}) => mf.dispatchFetch('https://journey.example.test/api/auth', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: raw ?? JSON.stringify(body) });
    const me = cookie => mf.dispatchFetch('https://journey.example.test/api/auth', { headers: cookie ? { Cookie: cookie } : {} }).then(r => r.json());
    return { mf, db, call, me };
}
const sessionCookie = response => response.headers.get('set-cookie')?.split(';')[0];

test('native D1 migration preserves legacy passwords, sessions, identities and ownership', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.me('avc_session=old-session')).user.username, 'user-1');
        const legacy = await f.call({ action: 'login', identifier: ' LEGACY@EXAMPLE.TEST ', password: legacyPassword });
        assert.equal(legacy.status, 200); const body = await legacy.json();
        assert.equal(body.user.id, 'legacy-one'); assert.equal(body.user.username, 'user-1');
        assert.equal((await f.db.prepare('SELECT owner FROM projects WHERE id=?').bind('old-repo').first()).owner, body.user.id);
        assert.equal((await f.call({ action: 'login', identifier: 'USER-2', password: legacyPassword })).status, 200);
        assert.equal((await f.call({ action: 'login', email: 'second@example.test', password: legacyPassword })).status, 200);
        assert.equal((await f.me()).mode, 'password', 'explicit password mode overrides legacy Access vars');
    } finally { await f.mf.dispose(); }
});

test('native authentication validates, normalizes, rotates and revokes sessions', async () => {
    const f = await fixture();
    try {
        for (const [body, code] of [[{ action: 'unknown' }, 'invalid_action'], [{ action: 'register', username: 'ab', email: 'ok@example.test', password: legacyPassword }, 'invalid_username'], [{ action: 'register', username: 'valid', email: 'bad', password: legacyPassword }, 'invalid_email'], [{ action: 'register', username: 'valid', email: 'ok@example.test', password: 'short' }, 'invalid_credentials']]) {
            const response = await f.call(body); assert.equal(response.status, 400); assert.equal((await response.json()).code, code);
        }
        assert.equal((await f.call(null, { raw: '{broken' })).status, 400);
        assert.equal((await f.call(null)).status, 400);
        assert.equal((await f.call(null, { raw: ' '.repeat(4097) })).status, 413);
        assert.equal((await f.call({ action: 'logout' }, { origin: 'https://evil.example' })).status, 403);
        const created = await f.call({ action: 'register', username: ' Alice_1 ', email: ' ALICE@EXAMPLE.TEST ', password: legacyPassword });
        assert.equal(created.status, 200); assert.equal(created.headers.get('cache-control'), 'no-store');
        assert.match(created.headers.get('set-cookie'), /HttpOnly; Path=\/; SameSite=Lax; Max-Age=604800; Secure/);
        const body = await created.json(), oldCookie = sessionCookie(created);
        assert.equal(body.user.username, 'alice_1'); assert.equal(body.user.email, 'alice@example.test'); assert(!('password' in body.user));
        assert.equal((await f.me(oldCookie)).user.id, body.user.id);
        const rotated = await f.call({ action: 'login', identifier: 'ALICE_1', password: legacyPassword }, { cookie: oldCookie });
        assert.equal(rotated.status, 200); const newCookie = sessionCookie(rotated); assert.notEqual(newCookie, oldCookie);
        assert.equal((await f.me(oldCookie)).user, null); assert.equal((await f.me(newCookie)).user.id, body.user.id);
        assert.equal((await f.me(newCookie + '; avc_session=other')).user, null, 'ambiguous session cookies denied');
        const logout = await f.call({ action: 'logout' }, { cookie: newCookie }); assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
        assert.equal((await f.me(newCookie)).user, null);
        assert.equal((await f.call({ action: 'login', identifier: 'alice@example.test', password: 'incorrect-password' })).status, 401);
        assert.equal((await f.call({ action: 'login', identifier: 'missing-account', password: legacyPassword })).status, 401);
        const emailLogin = await f.call({ action: 'login', identifier: 'ALICE@EXAMPLE.TEST', password: legacyPassword }); assert.equal(emailLogin.status, 200);
        await f.db.prepare('UPDATE sessions SET expires=0 WHERE user=?').bind(body.user.id).run(); assert.equal((await f.me(sessionCookie(emailLogin))).user, null);
    } finally { await f.mf.dispose(); }
});

test('D1 uniqueness arbitrates case-insensitive registration races and identity limits unify aliases', async () => {
    const f = await fixture();
    try {
        const responses = await Promise.all(['Race_User', 'race_user'].map((username, i) => f.call({ action: 'register', username, email: 'race' + i + '@example.test', password: legacyPassword }, { ip: '192.0.2.' + (i + 2) })));
        assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
        const duplicateUsername = responses.find(r => r.status === 409); assert.equal((await duplicateUsername.json()).code, 'username_exists');
        const emailRaces = await Promise.all(['Same@Example.test', 'same@example.test'].map((email, i) => f.call({ action: 'register', username: 'mailrace' + i, email, password: legacyPassword }, { ip: '192.0.2.' + (i + 4) })));
        assert.deepEqual(emailRaces.map(r => r.status).sort(), [200, 409]); assert.equal((await emailRaces.find(r => r.status === 409).json()).code, 'email_exists');
        await assert.rejects(f.db.prepare('INSERT INTO users(id,username,email,password) VALUES(?,?,?,?)').bind('direct', 'USER-1', 'new@example.test', legacyHash).run());
        for (let i = 0; i < 10; i++) assert.equal((await f.call({ action: 'login', identifier: i % 2 ? 'USER-1' : 'LEGACY@EXAMPLE.TEST', password: 'incorrect-password' }, { ip: '192.0.2.40' })).status, 401);
        const limited = await f.call({ action: 'login', identifier: 'user-1', password: legacyPassword }, { ip: '192.0.2.40' }); assert.equal(limited.status, 429);
        assert.equal((await limited.json()).code, 'rate_limited');
        await f.db.prepare('UPDATE auth_attempts SET reset=0').run();
        assert.equal((await f.call({ action: 'login', identifier: 'user-1', password: legacyPassword }, { ip: '192.0.2.40' })).status, 200);
        for (let i = 0; i < 60; i++) assert.equal((await f.call({ action: 'login', identifier: 'spray-' + i, password: legacyPassword }, { ip: '192.0.2.80' })).status, 401);
        assert.equal((await f.call({ action: 'login', identifier: 'spray-final', password: legacyPassword }, { ip: '192.0.2.80' })).status, 429);
    } finally { await f.mf.dispose(); }
});

test('explicit Access and invalid modes deny password authentication', async () => {
    for (const mode of ['access', 'typo']) {
        const f = await fixture(mode);
        try { const r = await f.call({ action: 'register', username: 'alice', email: 'alice@example.test', password: legacyPassword }); assert.equal(r.status, 403); assert.equal((await r.json()).code, 'access_authentication_required'); assert.equal((await f.me('avc_session=old-session')).user, null); }
        finally { await f.mf.dispose(); }
    }
});
