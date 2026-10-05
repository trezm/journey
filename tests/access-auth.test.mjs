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
function fixture({ keys = [jwk], fetcher, diagnostic } = {}) {
    let time = now, fetches = 0, currentKeys = keys;
    const verifier = new AccessVerifier({ now: () => time, diagnostic, fetch: async (url, options) => {
        fetches++; assert.equal(url, issuer + '/cdn-cgi/access/certs'); assert.equal(options.redirect, 'manual'); assert(options.signal);
        return fetcher ? fetcher(url, options) : Response.json({ keys: currentKeys });
    } });
    return { verifier, advance: ms => { time += ms; }, setKeys: value => { currentKeys = value; }, fetches: () => fetches, principal: (token, settings = env) => verifier.principal(request(token), settings) };
}

test('verified Access header preserves the administratively mapped owner identity', async () => {
    const f = fixture(), token = await jwt({ email: 'OWNER@example.test', sub: 'not-the-application-owner', owner: 'forged', role: 'coordinator' });
    assert.deepEqual(await f.principal(token), { id: ownerID, name: 'OWNER@example.test', agent: false });
    assert.equal(f.fetches(), 1);
});
test('signed Cloudflare tokens may omit the optional typ label in assertion headers and authorization cookies', async () => {
    const diagnostics = [], f = fixture({ diagnostic: value => diagnostics.push(value) }), token = await jwt({}, { typ: undefined });
    assert.equal(Object.hasOwn(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()), 'typ'), false);
    assert.deepEqual(await f.principal(token), { id: ownerID, name: 'owner@example.test', agent: false });
    const cookie = new Request('https://journey.example.test/api/avc', { headers: { Cookie: 'CF_Authorization=' + token } });
    assert.deepEqual(await f.verifier.principal(cookie, env), { id: ownerID, name: 'owner@example.test', agent: false });
    const m = modules(env, f.verifier);
    assert.equal((await (await m.route.GET(request(token))).json()).user.id, ownerID);
    assert.equal(diagnostics.length, 0);
});
test('omitting typ retains signature, algorithm, issuer, audience and application-identity enforcement', async () => {
    const diagnostics = [], f = fixture({ diagnostic: value => diagnostics.push(value) }), token = await jwt({}, { typ: undefined });
    const parts = token.split('.'), altered = parts[0] + '.' + b64(claims({ email: 'attacker@example.test' })) + '.' + parts[2];
    assert.equal(await f.principal(altered), null); assert.equal(diagnostics.at(-1).reason, 'signature_invalid');
    for (const [payload, header, reason] of [
        [{}, { alg: 'none' }, 'jwt_header_invalid'],
        [{ iss: 'https://other.cloudflareaccess.com' }, {}, 'identity_claims_invalid'],
        [{ aud: ['other-audience'] }, {}, 'audience_denied'],
        [{ type: 'org' }, {}, 'identity_claims_invalid'],
        [{ nbf: undefined }, {}, 'time_claims_invalid'],
        [{ email: 'unmapped@example.test' }, {}, 'owner_unmapped'],
    ]) {
        assert.equal(await f.principal(await jwt(payload, { typ: undefined, ...header })), null);
        assert.equal(diagnostics.at(-1).reason, reason); assert.equal(diagnostics.at(-1).typPresent, false); assert.equal(diagnostics.at(-1).typValid, true);
    }
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
        none: await jwt({}, { alg: 'none' }), HS256: await jwt({}, { alg: 'HS256' }), nullType: await jwt({}, { typ: null }), wrongType: await jwt({}, { typ: 'other' }), lowercaseType: await jwt({}, { typ: 'jwt' }), numericType: await jwt({}, { typ: 1 }), emptyType: await jwt({}, { typ: '' }), objectType: await jwt({}, { typ: {} }), critical: await jwt({}, { crit: [] }), embeddedKey: await jwt({}, { jwk }), remoteKey: await jwt({}, { jku: 'https://untrusted.example/key' }), unknownKey: await jwt({}, { kid: 'unknown' }),
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
    const diagnostics = [], diagnostic = value => diagnostics.push(value);
    const stalledFetch = fixture({ diagnostic, fetcher: () => new Promise(() => {}) });
    const stalledBody = fixture({ diagnostic, fetcher: async () => new Response(new ReadableStream({ start() {} })) });
    assert.deepEqual(await Promise.all([stalledFetch.principal(token), stalledBody.principal(token)]), [null, null]);
    assert.equal(diagnostics.length, 2);
    for (const value of diagnostics) { safeDiagnostic(value); assert.equal(value.reason, 'signing_keys_unavailable'); assert.equal(value.signingKeyFailure, 'timeout'); }
    assert(Date.now() - started < 11000); assert(Date.now() - started >= 7500);
});

const diagnosticBooleanFields = ['assertionPresent', 'authorizationCookiePresent', 'authorizationCookieUnambiguous', 'typPresent', 'typValid', 'typePresent', 'typeValid', 'nbfPresent', 'nbfValid'];
const diagnosticFields = ['event', 'reason', 'signingKeyFailure', ...diagnosticBooleanFields];
const signingKeyFailures = ['none', 'fetch_failed', 'http_error', 'response_invalid', 'key_import_failed', 'key_missing', 'refresh_throttled', 'timeout', 'capacity'];
const diagnosticReasons = ['configuration_invalid', 'token_missing', 'token_format_invalid', 'jwt_header_invalid', 'signing_keys_unavailable', 'signature_invalid', 'identity_claims_invalid', 'audience_denied', 'time_claims_invalid', 'owner_unmapped', 'verification_exception'];
function safeDiagnostic(value) {
    assert.deepEqual(Object.keys(value).sort(), [...diagnosticFields].sort());
    assert.equal(value.event, 'access_denied'); assert(diagnosticReasons.includes(value.reason));
    assert(signingKeyFailures.includes(value.signingKeyFailure));
    for (const key of diagnosticBooleanFields) assert.equal(typeof value[key], 'boolean');
}
test('signing-key diagnostics distinguish fetch, HTTP, response, missing-key and throttle failures without private data', async t => {
    const secret = 'PRIVATE_KEY_NETWORK_RESPONSE_SENTINEL', token = await jwt();
    for (const [stage, fetcher] of [
        ['fetch_failed', async () => { throw new Error(secret); }],
        ['http_error', async () => new Response(secret, { status: 503 })],
        ['response_invalid', async () => new Response(secret)],
        ['response_invalid', async () => Response.json({ keys: [{ ...jwk, kid: secret + '!' }] })],
    ]) await t.test(stage, async () => {
        const diagnostics = [], f = fixture({ fetcher, diagnostic: value => diagnostics.push(value) });
        assert.equal(await f.principal(token), null); safeDiagnostic(diagnostics[0]);
        assert.equal(diagnostics[0].reason, 'signing_keys_unavailable'); assert.equal(diagnostics[0].signingKeyFailure, stage);
        assert(!JSON.stringify(diagnostics).includes(secret));
    });
    const diagnostics = [], f = fixture({ diagnostic: value => diagnostics.push(value) });
    assert.equal(await f.principal(await jwt({}, { kid: 'unknown-key' })), null); assert.equal(diagnostics.at(-1).signingKeyFailure, 'key_missing');
    assert.equal(await f.principal(await jwt({}, { kid: 'unknown-key' })), null); assert.equal(diagnostics.at(-1).signingKeyFailure, 'refresh_throttled');
    assert.equal((await f.principal(token)).id, ownerID, 'cached valid keys still authenticate despite a rejected unknown-key request');
    for (const value of diagnostics) { safeDiagnostic(value); assert(!JSON.stringify(value).includes('unknown-key')); }
});
test('signing-key import diagnostics suppress arbitrary runtime errors and never authenticate', async () => {
    const source = readFileSync(new URL('../lib/avc/access.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const target = { exports: {} }, diagnostics = [], secret = 'PRIVATE_IMPORT_ERROR_KEY_SENTINEL';
    const deniedCrypto = { subtle: { importKey: async () => { throw new Error(secret); }, verify: crypto.subtle.verify.bind(crypto.subtle) } };
    runInNewContext(compiled, { module: target, exports: target.exports, crypto: deniedCrypto, atob, Date, Response, Request, URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout });
    const verifier = new target.exports.AccessVerifier({ now: () => now, fetch: async () => Response.json({ keys: [jwk] }), diagnostic: value => diagnostics.push(value) });
    assert.equal(await verifier.principal(request(await jwt()), env), null); safeDiagnostic(diagnostics[0]);
    assert.equal(diagnostics[0].signingKeyFailure, 'key_import_failed'); assert(!JSON.stringify(diagnostics).includes(secret));
});
test('signed tokens fail closed on every redirect response without following or changing the trusted key endpoint', async t => {
    const token = await jwt({}, { typ: undefined });
    for (const status of [301, 302, 303, 307, 308]) await t.test(String(status), async () => {
        const diagnostics = [], calls = [], f = fixture({ diagnostic: value => diagnostics.push(value), fetcher: async (input, init) => {
            calls.push({ input, redirect: init.redirect });
            return new Response(null, { status, headers: { Location: 'https://untrusted.example.test/redirected-signing-keys' } });
        } });
        assert.equal(await f.principal(token), null); assert.deepEqual(calls, [{ input: issuer + '/cdn-cgi/access/certs', redirect: 'manual' }]);
        safeDiagnostic(diagnostics[0]); assert.equal(diagnostics[0].signingKeyFailure, 'http_error');
        assert(!JSON.stringify(diagnostics).includes('untrusted.example.test'));
    });
});
test('signing-key concurrency capacity diagnostics are bounded and existing refreshes complete safely', async () => {
    const diagnostics = [], pending = [], verifier = new AccessVerifier({ now: () => now, diagnostic: value => diagnostics.push(value), fetch: () => new Promise(resolve => pending.push(resolve)) });
    const issuers = Array.from({ length: 5 }, (_, i) => 'https://fixture-' + i + '.cloudflareaccess.com');
    const tokens = await Promise.all(issuers.map(iss => jwt({ iss })));
    const principals = issuers.slice(0, 4).map((iss, i) => verifier.principal(request(tokens[i]), { ...env, AVC_ACCESS_TEAM_DOMAIN: iss }));
    assert.equal(pending.length, 4);
    assert.equal(await verifier.principal(request(tokens[4]), { ...env, AVC_ACCESS_TEAM_DOMAIN: issuers[4] }), null);
    safeDiagnostic(diagnostics[0]); assert.equal(diagnostics[0].signingKeyFailure, 'capacity');
    for (const resolve of pending) resolve(Response.json({ keys: [jwk] }));
    assert((await Promise.all(principals)).every(value => value?.id === ownerID));
    assert.equal(diagnostics.length, 1); assert(!JSON.stringify(diagnostics).includes('cloudflareaccess.com'));
});
test('failure diagnostics expose only fixed reasons and booleans; successful authentication emits nothing', async () => {
    const diagnostics = [], diagnostic = value => { assert(Object.isFrozen(value)); diagnostics.push(value); }, f = fixture({ diagnostic });
    assert.equal((await f.principal(await jwt())).id, ownerID); assert.equal(diagnostics.length, 0);
    const secret = 'PRIVATE_TOKEN_CLAIM_ERROR_CONFIGURATION_SENTINEL';
    const valid = await jwt({ extra: secret }), parts = valid.split('.');
    const tampered = parts[0] + '.' + b64(claims({ extra: secret + '-tampered' })) + '.' + parts[2];
    const cases = [
        ['configuration_invalid', () => f.principal(valid, { ...env, AVC_ACCESS_OWNER_MAP: secret })],
        ['token_missing', () => f.verifier.principal(new Request('https://private.example.test/' + secret), env)],
        ['token_format_invalid', () => f.principal(secret)],
        ['jwt_header_invalid', async () => f.principal(await jwt({ extra: secret }, { typ: null }))],
        ['signing_keys_unavailable', () => fixture({ diagnostic, fetcher: async () => { throw new Error(secret); } }).principal(valid)],
        ['signature_invalid', () => f.principal(tampered)],
        ['identity_claims_invalid', async () => f.principal(await jwt({ type: undefined, extra: secret }))],
        ['audience_denied', async () => f.principal(await jwt({ aud: secret, extra: secret }))],
        ['time_claims_invalid', async () => f.principal(await jwt({ nbf: undefined, extra: secret }))],
        ['owner_unmapped', async () => f.principal(await jwt({ email: secret + '@example.test', sub: secret }))],
        ['verification_exception', () => f.verifier.principal({ headers: { has() { throw new Error(secret); } } }, env)],
    ];
    for (const [reason, run] of cases) {
        assert.equal(await run(), null); const reported = diagnostics.at(-1); safeDiagnostic(reported); assert.equal(reported.reason, reason);
    }
    assert.equal(diagnostics.length, cases.length);
    assert(!JSON.stringify(diagnostics).includes(secret)); assert(!JSON.stringify(diagnostics).includes(ownerID)); assert(!JSON.stringify(diagnostics).includes('owner@example.test'));
    const header = diagnostics.find(value => value.reason === 'jwt_header_invalid'); assert.equal(header.typPresent, true); assert.equal(header.typValid, false);
    const identity = diagnostics.find(value => value.reason === 'identity_claims_invalid'); assert.equal(identity.typePresent, false); assert.equal(identity.typeValid, false);
    const times = diagnostics.find(value => value.reason === 'time_claims_invalid'); assert.equal(times.nbfPresent, false); assert.equal(times.nbfValid, false);
});
test('transport diagnostics distinguish missing assertion, ambiguous cookie and empty assertion without token values', async () => {
    const diagnostics = [], f = fixture({ diagnostic: value => diagnostics.push(value) }), token = await jwt();
    assert.equal(await f.verifier.principal(new Request('https://journey.example.test', { headers: { Cookie: 'CF_Authorization=' + token + '; CF_Authorization=' + token } }), env), null);
    assert.deepEqual([diagnostics[0].assertionPresent, diagnostics[0].authorizationCookiePresent, diagnostics[0].authorizationCookieUnambiguous], [false, true, false]);
    assert.equal(await f.verifier.principal(new Request('https://journey.example.test', { headers: { Cookie: 'CF_Authorization=' + token, 'Cf-Access-Jwt-Assertion': '' } }), env), null);
    assert.deepEqual([diagnostics[1].assertionPresent, diagnostics[1].authorizationCookiePresent, diagnostics[1].authorizationCookieUnambiguous], [true, true, true]);
    for (const value of diagnostics) { safeDiagnostic(value); assert.equal(value.reason, 'token_missing'); }
});
test('diagnostic sink exceptions and asynchronous rejections never change authentication decisions', async () => {
    for (const diagnostic of [() => { throw new Error('private sink error'); }, async () => { throw new Error('private async sink error'); }]) {
        const f = fixture({ diagnostic }); assert.equal(await f.principal('invalid'), null); assert.equal((await f.principal(await jwt())).id, ownerID);
    }
    await new Promise(resolve => setImmediate(resolve));
});
test('default server diagnostics contain only the fixed safe shape and suppress repeat failures for 30 seconds', async () => {
    const source = readFileSync(new URL('../lib/avc/access.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const target = { exports: {} }, logs = []; let time = now;
    runInNewContext(compiled, { module: target, exports: target.exports, crypto, fetch: async () => Response.json({ keys: [jwk] }), atob, Date: { now: () => time }, Response, Request, URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, console: { warn: message => logs.push(message) } });
    const verify = target.exports.accessPrincipal, token = await jwt();
    assert.equal((await verify(request(token), env)).id, ownerID); assert.equal(logs.length, 0);
    assert.equal(await verify(request(), env), null); assert.equal(logs.length, 1);
    assert.equal(await verify(request(), env), null); time += 29999; assert.equal(await verify(request(), env), null); assert.equal(logs.length, 1);
    time++; assert.equal(await verify(request(), env), null); assert.equal(logs.length, 2);
    assert.equal(await verify(request('PRIVATE_TOKEN_SENTINEL'), env), null); assert.equal(logs.length, 3);
    for (const log of logs) { assert.equal(typeof log, 'string'); safeDiagnostic(JSON.parse(log)); assert(!log.includes('PRIVATE_TOKEN_SENTINEL')); }
});

function modules(settings, verifier) {
    const require = createRequire(import.meta.url), sessions = [], queries = [];
    const db = { prepare: query => ({ bind: (...args) => ({ first: async () => {
        queries.push(query);
        if (query.startsWith('SELECT project,name,role')) return args[0] === await crypto.subtle.digest('SHA-256', new TextEncoder().encode('valid-agent')).then(v => Buffer.from(v).toString('hex')) ? { project: 'owned-project', name: 'Worker', role: 'worker' } : null;
        if (query.startsWith('SELECT owner')) return { owner: args[0] === 'owned-project' ? ownerID : 'another-owner' };
        if (query.startsWith('SELECT sessions')) { sessions.push(args); return { user: 'password-user', username: 'password-user', email: 'password@example.test' }; }
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

test('explicit password mode overrides stale Access config; invalid modes remain closed', async () => {
    const f = fixture();
    const password = modules({ ...env, AVC_AUTH_MODE: 'password' }, f.verifier);
    assert.equal(password.auth.authenticationMode(), 'password');
    const current = await password.auth.principal(new Request('https://journey.example.test/api/avc', { headers: { Cookie: 'avc_session=local-session' } }));
    assert.equal(current.name, 'password-user'); assert.equal(current.username, 'password-user');
    assert.equal(modules({ AVC_AUTH_MODE: 'access' }, f.verifier).auth.authenticationMode(), 'access');
    assert.equal(modules({ AVC_AUTH_MODE: 'misspelled' }, f.verifier).auth.authenticationMode(), 'access');
});
