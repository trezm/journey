import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const require = createRequire(new URL('../package.json', import.meta.url));
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Log, LogLevel } = wranglerRequire('miniflare');
const ts = require('typescript');
const deployment = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const now = 1_800_000_000_000, issuer = 'https://runtime-fixture.cloudflareaccess.com';
const audience = 'runtime-fixture-audience-0123456789', owner = 'siwc:disposable-runtime-owner';
const env = { AVC_ACCESS_TEAM_DOMAIN: issuer, AVC_ACCESS_AUD: audience, AVC_ACCESS_OWNER_MAP: JSON.stringify({ 'fixture@example.test': owner }) };
const pair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await webcrypto.subtle.exportKey('jwk', pair.publicKey), kid: 'disposable-runtime-key', alg: 'RS256', use: 'sig' };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const encoded = b64({ alg: 'RS256', kid: jwk.kid }) + '.' + b64({ iss: issuer, aud: [audience], sub: 'disposable-runtime-subject', email: 'fixture@example.test', type: 'app', iat: now / 1000 - 60, nbf: now / 1000 - 60, exp: now / 1000 + 3600 });
const token = encoded + '.' + Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(encoded))).toString('base64url');
const compiled = ts.transpileModule(readFileSync(new URL('../lib/avc/access.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const script = compiled + `
const fixtureKeys = ${JSON.stringify({ keys: [jwk] })};
export default {
    async fetch(request, env) {
        const diagnostics = [], calls = [];
        const verifier = new AccessVerifier({ now: () => ${now}, diagnostic: value => diagnostics.push(value), fetch: async (input, init) => {
            // Construct the outgoing request inside native Workerd. A Node-only
            // mock would miss the pinned runtime's unsupported redirect mode.
            const nativeRequest = new Request(input, init);
            calls.push({ endpointValid: nativeRequest.url === ${JSON.stringify(issuer + '/cdn-cgi/access/certs')}, redirect: nativeRequest.redirect, credentialsAbsent: !nativeRequest.headers.has('Authorization') && !nativeRequest.headers.has('Cookie') && !nativeRequest.headers.has('Cf-Access-Jwt-Assertion') });
            if (new URL(request.url).pathname === '/redirect') return new Response(null, { status: 302, headers: { Location: 'https://never-contact.invalid/signing-keys' } });
            return Response.json(fixtureKeys);
        } });
        const principal = await verifier.principal(request, env);
        return Response.json({ principal, diagnostics, calls });
    }
};`;

test('pinned native Worker verifies signed Access owners and refuses key redirects without external network', async t => {
    let mf, outboundAttempts = 0;
    try {
        mf = new Miniflare({ modules: true, script, compatibilityDate: deployment.compatibility_date, compatibilityFlags: deployment.compatibility_flags, bindings: env, log: new Log(LogLevel.NONE), outboundService: async () => { outboundAttempts++; return new Response(null, { status: 503 }); } });
        await t.test('assertion header authenticates using a supported native outgoing Request', async () => {
            const response = await mf.dispatchFetch('http://localhost/auth', { headers: { 'Cf-Access-Jwt-Assertion': token } });
            assert.equal(response.status, 200); const result = await response.json();
            assert.deepEqual(result.principal, { id: owner, name: 'fixture@example.test', agent: false }); assert.deepEqual(result.diagnostics, []);
            assert.deepEqual(result.calls, [{ endpointValid: true, redirect: 'manual', credentialsAbsent: true }]);
        });
        await t.test('bypassed API cookie authenticates with the same native signature checks', async () => {
            const response = await mf.dispatchFetch('http://localhost/auth', { headers: { Cookie: 'CF_Authorization=' + token } });
            assert.equal(response.status, 200); const result = await response.json();
            assert.equal(result.principal?.id, owner); assert.deepEqual(result.diagnostics, []);
            assert.deepEqual(result.calls, [{ endpointValid: true, redirect: 'manual', credentialsAbsent: true }]);
        });
        await t.test('redirect response denies owner without following or forwarding credentials', async () => {
            const response = await mf.dispatchFetch('http://localhost/redirect', { headers: { 'Cf-Access-Jwt-Assertion': token } });
            assert.equal(response.status, 200); const result = await response.json();
            assert.equal(result.principal, null); assert.deepEqual(result.calls, [{ endpointValid: true, redirect: 'manual', credentialsAbsent: true }]);
            assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].reason, 'signing_keys_unavailable'); assert.equal(result.diagnostics[0].signingKeyFailure, 'http_error');
            assert(!JSON.stringify(result.diagnostics).includes('never-contact.invalid'));
        });
        assert.equal(outboundAttempts, 0, 'native regression never contacts an external endpoint');
    } finally { if (mf) await mf.dispose(); }
});
