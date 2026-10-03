import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { accessEnabled, AccessVerifier } from '../lib/avc/access.ts';

const now = 1_800_000_000_000, issuer = 'https://fixture.cloudflareaccess.com', audience = 'fixture-audience-0123456789';
const ownerID = 'siwc:verified-source-owner';
const env = { AVC_ACCESS_TEAM_DOMAIN: issuer, AVC_ACCESS_AUD: audience, AVC_ACCESS_OWNER_MAP: JSON.stringify({ 'owner@example.test': ownerID }) };
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'primary', alg: 'RS256', use: 'sig' };
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const claims = extra => ({ iss: issuer, aud: [audience], sub: 'verified-access-subject', email: 'owner@example.test', type: 'app', iat: now / 1000 - 60, nbf: now / 1000 - 60, exp: now / 1000 + 3600, ...extra });
async function jwt(payload = {}, header = {}, signingKey = keyPair.privateKey) {
    const encoded = b64({ alg: 'RS256', typ: 'JWT', kid: 'primary', ...header }) + '.' + b64(claims(payload));
    return encoded + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(encoded))).toString('base64url');
}
const request = token => new Request('https://journey.example.test/api/avc', { headers: token === undefined ? {} : { 'Cf-Access-Jwt-Assertion': token } });
function fixture({ keys = [jwk], fetcher } = {}) {
    let time = now, fetches = 0, currentKeys = keys;
    const verifier = new AccessVerifier({ now: () => time, fetch: async (url, options) => {
        fetches++; assert.equal(url, issuer + '/cdn-cgi/access/certs'); assert.equal(options.redirect, 'error'); assert(options.signal);
        return fetcher ? fetcher(url, options) : Response.json({ keys: currentKeys });
    } });
    return { verifier, advance: ms => { time += ms; }, setKeys: value => { currentKeys = value; }, fetches: () => fetches, principal: (token, settings = env) => verifier.principal(request(token), settings) };
}

test('verified Access header preserves the administratively mapped owner identity', async () => {
    const f = fixture(), token = await jwt({ email: 'OWNER@example.test', sub: 'not-the-application-owner', owner: 'forged', role: 'coordinator' });
    assert.deepEqual(await f.principal(token), { id: ownerID, name: 'OWNER@example.test', agent: false });
    assert.equal(f.fetches(), 1);
});
test('bypassed browser API cookie receives the same checks; ambiguous cookies and invalid assertion headers fail', async () => {
    const f = fixture(), token = await jwt();
    const cookie = new Request('https://journey.example.test/api/avc', { headers: { Cookie: 'irrelevant=1; CF_Authorization=' + token } });
    assert.equal((await f.verifier.principal(cookie, env)).id, ownerID);
    assert.equal(await f.verifier.principal(new Request(cookie, { headers: { Cookie: 'CF_Authorization=' + token + '; CF_Authorization=' + token } }), env), null);
    assert.equal(await f.verifier.principal(new Request(cookie, { headers: { Cookie: 'CF_Authorization=' + token, 'Cf-Access-Jwt-Assertion': 'invalid' } }), env), null);
});
test('malformed, unsigned, altered, oversized and unsupported-header tokens never authenticate', async t => {
    const valid = await jwt(), f = fixture();
    const pieces = valid.split('.');
    const cases = {
        missing: undefined, malformed: 'garbage', unsigned: pieces.slice(0, 2).join('.') + '.', altered: pieces[0] + '.' + b64(claims({ email: 'attacker@example.test' })) + '.' + pieces[2], oversized: 'a'.repeat(16385), extraSegment: valid + '.x',
        none: await jwt({}, { alg: 'none' }), HS256: await jwt({}, { alg: 'HS256' }), noType: await jwt({}, { typ: undefined }), critical: await jwt({}, { crit: [] }), embeddedKey: await jwt({}, { jwk }), remoteKey: await jwt({}, { jku: 'https://untrusted.example/key' }), unknownKey: await jwt({}, { kid: 'unknown' }),
    };
    for (const [name, token] of Object.entries(cases)) await t.test(name, async () => assert.equal(await f.principal(token), null));
});
test('signed tokens still require exact issuer, audience, application type, mapped email and valid times', async t => {
    const f = fixture();
    const cases = {
        foreignIssuer: { iss: 'https://other.cloudflareaccess.com' }, wrongAudience: { aud: ['different-audience'] }, emptyAudience: { aud: [] }, mixedAudience: { aud: [audience, 2] }, unmappedEmail: { email: 'someone-else@example.test' }, missingEmail: { email: undefined }, noSubject: { sub: '' }, noType: { type: undefined }, globalSession: { type: 'org' }, service: { email: undefined, common_name: 'service-token' }, expired: { exp: now / 1000 }, futureNotBefore: { nbf: now / 1000 + 60 }, futureIssued: { iat: now / 1000 + 60 }, missingExpiry: { exp: undefined }, missingIssued: { iat: undefined }, missingNotBefore: { nbf: undefined }, fractionalExpiry: { exp: now / 1000 + .5 }, backwardExpiry: { iat: now / 1000 + 1, exp: now / 1000 + 1 },
    };
    for (const [name, payload] of Object.entries(cases)) await t.test(name, async () => assert.equal(await f.principal(await jwt(payload)), null));
    assert.equal((await f.principal(await jwt({ aud: audience }))).id, ownerID);
});
test('partial and unsafe configuration fails closed without any key fetch', async t => {
    const token = await jwt();
    for (const [name, settings] of Object.entries({ partial: { AVC_ACCESS_AUD: audience }, insecure: { ...env, AVC_ACCESS_TEAM_DOMAIN: 'http://fixture.cloudflareaccess.com' }, foreignDomain: { ...env, AVC_ACCESS_TEAM_DOMAIN: 'https://fixture.example.test' }, issuerPath: { ...env, AVC_ACCESS_TEAM_DOMAIN: issuer + '/certs' }, emptyMapping: { ...env, AVC_ACCESS_OWNER_MAP: '{}' }, malformedMapping: { ...env, AVC_ACCESS_OWNER_MAP: 'invalid' }, duplicateNormalizedMapping: { ...env, AVC_ACCESS_OWNER_MAP: JSON.stringify({ 'owner@example.test': ownerID, 'OWNER@example.test': 'other' }) } })) await t.test(name, async () => { const f = fixture(); assert(accessEnabled(settings)); assert.equal(await f.principal(token, settings), null); assert.equal(f.fetches(), 0); });
    assert.equal(accessEnabled({}), false);
});
test('key cache coalesces concurrent verification, expires and accepts rotation with bounded refresh', async () => {
    const f = fixture(), token = await jwt();
    const owners = await Promise.all(Array.from({ length: 12 }, () => f.principal(token)));
    assert(owners.every(value => value?.id === ownerID)); assert.equal(f.fetches(), 1);
    assert.equal(await f.principal(await jwt({}, { kid: 'unknown' })), null); assert.equal(f.fetches(), 1);
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    f.setKeys([jwk, { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'rotated', alg: 'RS256', use: 'sig' }]); f.advance(31000);
    assert.equal((await f.principal(await jwt({}, { kid: 'rotated' }, pair.privateKey))).id, ownerID); assert.equal(f.fetches(), 2);
    f.advance(600000); assert.equal((await f.principal(token)).id, ownerID); assert.equal(f.fetches(), 3);
});
test('unavailable, excessive, ambiguous and invalid JWKS fail closed and retry is throttled', async t => {
    const token = await jwt();
    for (const [name, fetcher] of Object.entries({ unavailable: async () => new Response('', { status: 503 }), nonJSON: async () => new Response('bad'), excessiveHeader: async () => new Response('{}', { headers: { 'content-length': '65537' } }), excessiveBody: async () => new Response(' '.repeat(65537)), duplicateKids: async () => Response.json({ keys: [jwk, jwk] }), tooManyKeys: async () => Response.json({ keys: Array(33).fill(jwk) }), weakKey: async () => Response.json({ keys: [{ ...jwk, n: 'AQAB' }] }), wrongAlgorithm: async () => Response.json({ keys: [{ ...jwk, alg: 'HS256' }] }) })) await t.test(name, async () => { const f = fixture({ fetcher }); assert.equal(await f.principal(token), null); assert.equal(await f.principal(token), null); assert.equal(f.fetches(), 1); });
});
test('a stalled JWKS fetch or response body has a bounded deadline and denies authentication', async () => {
    const started = Date.now(), token = await jwt();
    const stalledFetch = fixture({ fetcher: () => new Promise(() => {}) });
    const stalledBody = fixture({ fetcher: async () => new Response(new ReadableStream({ start() {} })) });
    assert.deepEqual(await Promise.all([stalledFetch.principal(token), stalledBody.principal(token)]), [null, null]);
    assert(Date.now() - started < 11000); assert(Date.now() - started >= 7500);
});

function modules(settings, verifier) {
    const require = createRequire(import.meta.url), sessions = [], queries = [];
    const db = { prepare: query => ({ bind: (...args) => ({ first: async () => {
        queries.push(query);
        if (query.startsWith('SELECT project,name,role')) return args[0] === await crypto.subtle.digest('SHA-256', new TextEncoder().encode('valid-agent')).then(v => Buffer.from(v).toString('hex')) ? { project: 'owned-project', name: 'Worker', role: 'worker' } : null;
        if (query.startsWith('SELECT owner')) return { owner: args[0] === 'owned-project' ? ownerID : 'another-owner' };
        if (query.startsWith('SELECT sessions')) { sessions.push(args); return { user: 'password-user', email: 'password@example.test' }; }
        return null;
    }, run: async () => { queries.push(query); return { meta: { changes: 1 } }; } }) }) };
    class ProtocolError extends Error { constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; } }
    const core = { ProtocolError, insist: (ok, code, message, status) => { if (!ok) throw new ProtocolError(code, message, status); } };
    const storage = { bindings: () => ({ db }) };
    const evaluate = (relative, dependencies) => {
        const source = readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
        const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const target = { exports: {} };
        runInNewContext(compiled, { module: target, exports: target.exports, require: name => dependencies[name] ?? require(name), crypto, atob, Date, Response, Request, URL, TextEncoder, TextDecoder });
        return target.exports;
    };
    const auth = evaluate('lib/avc/auth.ts', { 'cloudflare:workers': { env: settings }, './access.ts': { accessEnabled, accessPrincipal: (req, settings) => verifier.principal(req, settings) }, './storage.ts': storage, './core.ts': core });
    const route = evaluate('app/api/auth/route.ts', { '@/lib/avc/storage': storage, '@/lib/avc/auth': auth, '@/lib/avc/core': core });
    return { auth, route, queries, sessions };
}
test('actual auth keeps Bearer/Basic agent precedence and project scoping in Access mode', async () => {
    const f = fixture(), m = modules(env, f.verifier), ownerToken = await jwt();
    for (const Authorization of ['Bearer valid-agent', 'Basic ' + Buffer.from('x:valid-agent').toString('base64'), 'bearer valid-agent', 'basic ' + Buffer.from('x:valid-agent').toString('base64')]) {
        const req = new Request('https://journey.example.test/api/avc', { headers: { Authorization, 'Cf-Access-Jwt-Assertion': ownerToken } });
        const principal = await m.auth.authorize(req, 'owned-project'); assert.equal(principal.agent, true); assert.equal(principal.role, 'worker');
        await assert.rejects(m.auth.authorize(req, 'foreign-project'), error => error.code === 'forbidden');
    }
    assert.equal(await m.auth.principal(new Request('https://journey.example.test/api/avc', { headers: { Authorization: 'Bearer invalid-agent', 'Cf-Access-Jwt-Assertion': ownerToken } })), null);
    for (const Authorization of ['Bearer', 'Bearer ', 'Basic', 'Basic malformed!', 'Basic ' + Buffer.from('no-colon').toString('base64'), 'Basic ' + Buffer.from('x:').toString('base64')])
        assert.equal(await m.auth.principal(new Request('https://journey.example.test/api/avc', { headers: { Authorization, Cookie: 'CF_Authorization=' + ownerToken, 'Cf-Access-Jwt-Assertion': ownerToken } })), null);
    assert.equal(f.fetches(), 0, 'repository credentials never trigger Access key fetching');
});
test('actual owner authorization preserves ownership and never falls back to local sessions or raw identity', async () => {
    const f = fixture(), m = modules(env, f.verifier), req = request(await jwt());
    assert.equal((await m.auth.authorize(req, 'owned-project')).id, ownerID);
    await assert.rejects(m.auth.authorize(req, 'foreign-project'), error => error.code === 'forbidden');
    assert.equal(await m.auth.principal(new Request('https://journey.example.test/api/avc', { headers: { Cookie: 'avc_session=valid-local-session', 'oai-authenticated-user-id': ownerID, 'Cf-Access-Authenticated-User-Email': 'owner@example.test' } })), null);
    assert.equal(m.sessions.length, 0);
    const partial = modules({ AVC_ACCESS_TEAM_DOMAIN: issuer }, f.verifier);
    assert.equal(await partial.auth.principal(new Request('https://journey.example.test/api/avc', { headers: { Cookie: 'avc_session=valid-local-session' } })), null); assert.equal(partial.sessions.length, 0);
});
test('actual auth route exposes Access mode, rejects password enrollment and returns Access logout', async () => {
    const f = fixture(), m = modules(env, f.verifier);
    const signedIn = await m.route.GET(request(await jwt()));
    assert.equal(signedIn.headers.get('cache-control'), 'no-store'); assert.equal((await signedIn.json()).user.id, ownerID);
    for (const action of ['register', 'login']) {
        const response = await m.route.POST(new Request('https://journey.example.test/api/auth', { method: 'POST', headers: { Origin: 'https://journey.example.test' }, body: JSON.stringify({ action, email: 'owner@example.test', password: 'not-used-in-access-mode' }) }));
        assert.equal(response.status, 403); assert.equal((await response.json()).code, 'access_authentication_required');
    }
    const logout = await m.route.POST(new Request('https://journey.example.test/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) }));
    assert.equal((await logout.json()).logoutUrl, '/cdn-cgi/access/logout');
    const crossOrigin = await m.route.POST(new Request('https://journey.example.test/api/auth', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: JSON.stringify({ action: 'logout' }) }));
    assert.equal(crossOrigin.status, 403);
});
test('deployments with no Access configuration retain password-session authentication', async () => {
    const f = fixture(), m = modules({}, f.verifier);
    assert.equal(m.auth.authenticationMode(), 'password');
    assert.equal((await m.auth.principal(new Request('https://journey.example.test/api/avc', { headers: { Cookie: 'avc_session=local-session' } }))).id, 'password-user');
    assert.equal(m.sessions.length, 1);
    assert.equal(await m.auth.principal(request(await jwt())), null);
});
