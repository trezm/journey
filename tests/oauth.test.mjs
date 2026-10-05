import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../drizzle/0005_oauth_connections.sql', import.meta.url), 'utf8'));
sqlite.exec('CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,password TEXT,username TEXT); CREATE TABLE sessions(digest TEXT PRIMARY KEY,user TEXT,expires INTEGER); CREATE TABLE projects(id TEXT PRIMARY KEY,owner TEXT,name TEXT,version INTEGER,state TEXT,visibility TEXT);');
const db = { prepare(sql) { return { bind(...args) { return { async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; } }; } }; } };
globalThis.__oauthEnv = { DB: db, BUCKET: {}, GITHUB_SYNC_KEY: 'a'.repeat(64), AVC_AUTH_MODE: 'password', AVC_OAUTH_ORIGIN: 'https://journey.test', AVC_GITHUB_CLIENT_ID: 'github-client', AVC_GITHUB_CLIENT_SECRET: 'github-secret', AVC_GITLAB_CLIENT_ID: 'gitlab-client', AVC_GITLAB_CLIENT_SECRET: 'gitlab-secret' };
registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: 'data:text/javascript,export const env=globalThis.__oauthEnv;' };
    if (specifier.startsWith('@/')) { let path = resolve(specifier.slice(2)); if (!existsSync(path)) path += '.ts'; return { shortCircuit: true, url: pathToFileURL(path).href }; }
    return next(specifier, context);
} });
const oauth = await import('../lib/avc/oauth.ts');
const route = await import('../app/api/oauth/[provider]/route.ts');
const callback = await import('../app/api/oauth/[provider]/callback/route.ts');
const secret = globalThis.__oauthEnv.GITHUB_SYNC_KEY;
const context = p => ({ params: Promise.resolve({ provider: p }) });
const request = (path = '/', extra = {}) => new Request('https://journey.test' + path, { headers: { cookie: 'avc_session=owner-session', origin: 'https://journey.test', ...extra.headers }, ...extra, ...(extra.headers ? { headers: { cookie: 'avc_session=owner-session', origin: 'https://journey.test', ...extra.headers } } : {}) });
sqlite.prepare('INSERT INTO users VALUES(?,?,?,?)').run('owner', 'owner@test', 'irrelevant', 'owner');
sqlite.prepare('INSERT INTO users VALUES(?,?,?,?)').run('other', 'other@test', 'irrelevant', 'other');
sqlite.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await oauth.hash('owner-session'), 'owner', Date.now() + 600_000);
sqlite.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await oauth.hash('other-session'), 'other', Date.now() + 600_000);
sqlite.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)').run('repo', 'owner', 'repo', 0, '{}', 'private');
test('AES-GCM binds provider tokens to the account and detects tampering', async () => {
    const encrypted = await oauth.encrypt('private-token', 'owner:github', secret);
    assert(!encrypted.includes('private-token')); assert.equal(await oauth.decrypt(encrypted, 'owner:github', secret), 'private-token');
    await assert.rejects(oauth.decrypt(encrypted, 'other:github', secret)); await assert.rejects(oauth.decrypt(encrypted, 'owner:github', 'b'.repeat(64)));
});
test('OAuth origin validation and POST start reject CSRF, public readers, and signed-out requests', async () => {
    assert.throws(() => oauth.oauthConfig('github', { AVC_OAUTH_ORIGIN: 'https://journey.test/evil', AVC_GITHUB_CLIENT_ID: 'id', AVC_GITHUB_CLIENT_SECRET: 'secret' }));
    const body = JSON.stringify({ project: 'repo' });
    for (const headers of [{ origin: 'https://evil.test' }, { cookie: '' }, { cookie: 'avc_session=other-session' }]) {
        const response = await route.POST(request('/api/oauth/github', { method: 'POST', body, headers }), context('github')); assert([401, 403].includes(response.status));
    }
    const good = await route.POST(request('/api/oauth/github', { method: 'POST', body }), context('github'));
    assert.equal(good.status, 200); const target = new URL((await good.json()).url);
    assert.equal(target.origin, 'https://github.com'); assert.equal(target.searchParams.get('code_challenge_method'), 'S256'); assert.equal(target.searchParams.get('redirect_uri'), 'https://journey.test/api/oauth/github/callback');
    assert.equal(target.searchParams.get('state').length, 43); assert.equal(target.searchParams.get('code_challenge').length, 43); assert(!target.href.includes('github-secret'));
});
test('state is user, session, provider and expiry bound, then consumed atomically once', async () => {
    const url = new URL(await oauth.startOAuth('gitlab', 'owner', 'session-binding', 'repo', 'https://journey.test')), state = url.searchParams.get('state');
    await assert.rejects(oauth.consumeState('github', state, 'owner', 'session-binding'), error => error.code === 'oauth_state');
    await assert.rejects(oauth.consumeState('gitlab', state, 'other', 'session-binding'), error => error.code === 'oauth_state');
    await assert.rejects(oauth.consumeState('gitlab', state, 'owner', 'different-session'), error => error.code === 'oauth_state');
    const results = await Promise.allSettled([oauth.consumeState('gitlab', state, 'owner', 'session-binding'), oauth.consumeState('gitlab', state, 'owner', 'session-binding')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const success = results.find(result => result.status === 'fulfilled').value;
    assert.equal(success.project, 'repo');
    assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(success.verifier))).toString('base64url'), url.searchParams.get('code_challenge'));
    const expired = new URL(await oauth.startOAuth('gitlab', 'owner', 'session-binding', 'repo', 'https://journey.test')).searchParams.get('state');
    sqlite.prepare('UPDATE oauth_states SET expires=0 WHERE digest=?').run(await oauth.hash(expired));
    await assert.rejects(oauth.consumeState('gitlab', expired, 'owner', 'session-binding'), error => error.code === 'oauth_state');
});
test('callback rejects changed sessions, exchanges PKCE server-side, persists encrypted tokens and has a fixed redirect', async t => {
    const binding = await oauth.sessionBinding(request()), authorization = new URL(await oauth.startOAuth('github', 'owner', binding, 'repo', 'https://journey.test')), state = authorization.searchParams.get('state');
    let calls = 0; const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (url, init) => {
        calls++; assert.equal(init.redirect, 'manual');
        if (url.includes('/access_token')) { const params = new URLSearchParams(init.body); assert.equal(params.get('client_secret'), 'github-secret'); assert.equal(params.get('redirect_uri'), 'https://journey.test/api/oauth/github/callback'); assert.equal(params.get('code_verifier').length, 43); return Response.json({ access_token: 'private-access-token', token_type: 'bearer', refresh_token: 'private-refresh-token', expires_in: 3600 }); }
        assert.equal(init.headers.Authorization, 'Bearer private-access-token'); return Response.json({ id: 55, login: 'octocat' });
    };
    const path = `/api/oauth/github/callback?state=${state}&code=private-code&returnTo=https://evil.test`;
    const switched = await callback.GET(request(path, { headers: { cookie: 'avc_session=other-session' } }), context('github')); assert.equal(switched.status, 400); assert.equal(calls, 0);
    const loggedOut = await callback.GET(request(path, { headers: { cookie: '' } }), context('github')); assert.equal(loggedOut.status, 401); assert.equal(calls, 0);
    const success = await callback.GET(request(path), context('github'));
    assert.equal(success.status, 303); assert.equal(success.headers.get('location'), 'https://journey.test/settings?project=repo&oauth=connected'); assert.equal(calls, 2);
    const row = await oauth.connection('owner', 'github'); assert(!row.credential.includes('private-')); assert.equal(await oauth.connectionToken('owner', 'github'), 'private-access-token');
    const replay = await callback.GET(request(path), context('github')); assert.equal(replay.status, 400); assert.equal(calls, 2);
    const view = await route.GET(request('/api/oauth/github?project=repo'), context('github')); const visible = JSON.stringify(await view.json()); assert(visible.includes('octocat')); assert(!visible.includes('private-')); assert(!visible.includes('credential'));
});
test('rotating GitLab refresh tokens are serialized and saved before reuse', async t => {
    const id = await oauth.hash('owner:gitlab'), context = `oauth-connection:${id}:owner:gitlab`;
    const credential = await oauth.encrypt(JSON.stringify({ access: 'old-access-token', refresh: 'old-refresh-token', expires: Date.now() - 1 }), context, secret);
    sqlite.prepare('INSERT OR REPLACE INTO oauth_connections(id,user,provider,provider_user,username,credential,updated) VALUES(?,?,?,?,?,?,?)').run(id, 'owner', 'gitlab', '22', 'alice', credential, 1);
    let calls = 0; const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (_url, init) => { calls++; assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'old-refresh-token'); await new Promise(resolve => setTimeout(resolve, 20)); return Response.json({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 7200, token_type: 'Bearer' }); };
    const results = await Promise.allSettled([oauth.connectionToken('owner', 'gitlab'), oauth.connectionToken('owner', 'gitlab')]);
    assert.equal(calls, 1); assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(await oauth.connectionToken('owner', 'gitlab'), 'new-access-token'); assert.equal(calls, 1);
    const row = await oauth.connection('owner', 'gitlab'); assert.equal(JSON.parse(await oauth.decrypt(row.credential, context, secret)).refresh, 'new-refresh-token');
});
test('provider responses never echo credentials, redirect destinations or raw OAuth errors', async () => {
    await assert.rejects(oauth.providerJSON('https://github.com/login/oauth/access_token', undefined, {}, async () => new Response('secret token leak', { status: 400 })), error => !error.message.includes('secret token leak'));
    await assert.rejects(oauth.providerJSON('https://gitlab.com/api/v4/user', 'private-token', {}, async (_url, init) => { assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }); }));
    await assert.rejects(oauth.providerJSON('https://evil.test/api', 'private-token'));
});
test('owner OAuth connection drives hosted GitLab export/import across queue continuations without token disclosure', async t => {
    const { GitStore, object } = await import('../lib/avc/git.ts');
    const { encodeState, decodeState } = await import('../lib/avc/state-codec.ts');
    const { storeOAuthCredential, runCloudSync, publicSync } = await import('../lib/avc/github-cloud.ts');
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { inflateSync } = await import('node:zlib');
    const values = new Map();
    const bucket = { async put(key, value) { values.set(key, typeof value === 'string' ? Buffer.from(value) : Uint8Array.from(value)); }, async get(key) { const data = values.get(key); return data ? { text: async () => Buffer.from(data).toString(), arrayBuffer: async () => Uint8Array.from(data).buffer } : null; }, async head(key) { return values.has(key) ? {} : null; } };
    globalThis.__oauthEnv.BUCKET = bucket;
    const git = new GitStore(bucket, 'repo'), initial = await git.save({ file: 'initial' }, undefined, 'initial', 'Owner');
    const path = mkdtempSync(join(tmpdir(), 'journey-oauth-hosted-')); t.after(() => rmSync(path, { recursive: true, force: true }));
    execFileSync('git', ['init', '--bare', '--quiet', path]);
    const native = (args, input) => execFileSync('git', ['--git-dir=' + path, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'] });
    native(['config', 'uploadpack.allowFilter', 'true']); native(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    for (const [name, data] of values) if (name.includes('/objects/')) { const raw = inflateSync(data), nul = raw.indexOf(0), type = raw.subarray(0, nul).toString().split(' ')[0]; native(['hash-object', '-w', '-t', type, '--stdin'], raw.subarray(nul + 1)); }
    native(['update-ref', 'refs/heads/main', initial.oid]);
    const id = await oauth.hash('owner:gitlab'), context = `oauth-connection:${id}:owner:gitlab`;
    sqlite.prepare('UPDATE oauth_connections SET credential=? WHERE id=?').run(await oauth.encrypt(JSON.stringify({ access: 'hosted-private-token' }), context, secret), id);
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    let pushes = 0;
    globalThis.fetch = async (url, init = {}) => {
        const parsed = new URL(url); assert.equal(parsed.hostname, 'gitlab.com'); assert.equal(init.redirect, 'manual');
        if (parsed.pathname.endsWith('/info/refs')) return new Response(execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', path]));
        if (parsed.pathname.endsWith('/git-upload-pack') || parsed.pathname.endsWith('/git-receive-pack')) {
            assert.equal(init.headers.Authorization, 'Basic ' + btoa('oauth2:hosted-private-token'));
            if (parsed.pathname.endsWith('/git-receive-pack')) pushes++;
            return new Response(execFileSync('git', [parsed.pathname.endsWith('/git-upload-pack') ? 'upload-pack' : 'receive-pack', '--stateless-rpc', path], { input: init.body, stdio: ['pipe', 'pipe', 'pipe'] }));
        }
        assert.equal(init.headers.Authorization, 'Bearer hosted-private-token');
        const branch = parsed.pathname.split('/repository/branches/')[1];
        if (branch) { try { return Response.json({ commit: { id: native(['rev-parse', '--verify', 'refs/heads/' + decodeURIComponent(branch)]).toString().trim() } }); } catch { return new Response('', { status: 404 }); } }
        const blob = parsed.pathname.match(/\/repository\/blobs\/([a-f0-9]{40})\/raw$/)?.[1];
        if (blob) return new Response(native(['cat-file', 'blob', blob]));
        const commit = parsed.pathname.match(/\/repository\/commits\/([a-f0-9]{40})$/)?.[1];
        if (commit) { try { native(['cat-file', 'commit', commit]); return Response.json({ id: commit }); } catch { return new Response('', { status: 404 }); } }
        return Response.json({ id: 2, namespace: { kind: 'user' }, permissions: { project_access: { access_level: 40 } } });
    };
    const credential = await storeOAuthCredential('repo', 'owner', 'https://gitlab.com/owner/repo.git', secret);
    assert(!Buffer.from(values.get(`repo/cloud-credentials/${credential}`)).toString().includes('hosted-private-token'));
    const outgoing = await git.save(Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['file-' + i, 'value-' + i])), initial.oid, 'Journey work', 'Owner');
    const state = { id: 'repo', name: 'Repo', head: outgoing.oid, revisions: { [initial.oid]: initial.meta, [outgoing.oid]: outgoing.meta }, journeys: [], leases: [], waiting: [], events: [], sequence: 0, integrationCursor: 0, generation: 0, receipts: {}, requireApproval: true, sync: { remote: 'https://gitlab.com/owner/repo.git', branch: 'main', enabled: true, status: 'idle', updatedAt: 1, cloud: { credential, generation: 'generation' } } };
    sqlite.prepare('UPDATE projects SET state=? WHERE id=?').run(encodeState(state), 'repo');
    let deliveries = 0;
    async function drain(target) {
        for (let i = 0; i < 30; i++) {
            await runCloudSync('repo', secret); deliveries++;
            const value = decodeState(sqlite.prepare('SELECT state FROM projects WHERE id=?').get('repo').state);
            assert.notEqual(value.sync.status, 'error', value.sync.error);
            assert(!JSON.stringify(publicSync(value)).includes(credential)); assert(!JSON.stringify(value).includes('hosted-private-token'));
            if (!value.sync.run && value.sync.lastSyncedHead === target) return value;
        }
        assert.fail('Hosted GitLab sync did not finish');
    }
    await drain(outgoing.oid); assert(deliveries > 1); assert(pushes > 30);
    assert.equal(native(['rev-parse', 'refs/heads/main']).toString().trim(), outgoing.oid);
    const treeLine = Buffer.from((await git.read(outgoing.oid)).body).toString().split('\n')[0];
    const incomingBody = Buffer.from(`${treeLine}\nparent ${outgoing.oid}\nauthor Remote <r@e> 4 +0000\ncommitter Remote <r@e> 4 +0000\n\nremote change\n`);
    const incoming = (await object('commit', incomingBody)).oid;
    native(['hash-object', '-w', '-t', 'commit', '--stdin'], incomingBody); native(['update-ref', 'refs/heads/main', incoming, outgoing.oid]);
    const before = decodeState(sqlite.prepare('SELECT state FROM projects WHERE id=?').get('repo').state); delete before.sync.cloud.nextAttemptAt; sqlite.prepare('UPDATE projects SET state=? WHERE id=?').run(encodeState(before), 'repo');
    const final = await drain(incoming); assert.equal(final.head, incoming); assert.deepEqual(Buffer.from((await git.read(incoming)).body), incomingBody);
    // Ownership changes cannot keep using the former owner's encrypted link.
    sqlite.prepare('UPDATE projects SET owner=? WHERE id=?').run('other', 'repo');
    const attempt = decodeState(sqlite.prepare('SELECT state FROM projects WHERE id=?').get('repo').state); delete attempt.sync.cloud.nextAttemptAt; sqlite.prepare('UPDATE projects SET state=? WHERE id=?').run(encodeState(attempt), 'repo');
    const beforePushes = pushes; await runCloudSync('repo', secret); assert.equal(pushes, beforePushes);
    assert.equal(decodeState(sqlite.prepare('SELECT state FROM projects WHERE id=?').get('repo').state).sync.status, 'error');
    sqlite.prepare('UPDATE projects SET owner=? WHERE id=?').run('owner', 'repo');
});
test('native workerd OAuth callback consumes D1 state once and stores encrypted provider tokens', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare', { paths: [require.resolve('wrangler')] })).href);
    const { build } = await import(pathToFileURL(require.resolve('esbuild', { paths: [require.resolve('wrangler')] })).href);
    let exchanges = 0, profiles = 0;
    const outboundService = async request => {
        const url = new URL(request.url);
        if (url.pathname === '/login/oauth/access_token' || url.pathname === '/oauth/token') {
            exchanges++;
            const body = new URLSearchParams(await request.text());
            assert.equal(body.get('code_verifier')?.length, 43);
            assert(body.get('redirect_uri')?.startsWith('https://journey.test/api/oauth/'));
            assert.equal(body.get('grant_type'), 'authorization_code');
            assert(['github-secret', 'gitlab-secret'].includes(body.get('client_secret')));
            return Response.json({ access_token: 'native-private-access', refresh_token: 'native-private-refresh', expires_in: 3600, token_type: 'Bearer' });
        }
        assert(['api.github.com', 'gitlab.com'].includes(url.hostname));
        assert.equal(request.headers.get('Authorization'), 'Bearer native-private-access'); profiles++;
        return Response.json({ id: 77, login: 'native-user', username: 'native-user' });
    };
    const bundle = await build({ stdin: {
        contents: `import * as provider from './app/api/oauth/[provider]/route.ts';
        import * as callback from './app/api/oauth/[provider]/callback/route.ts';
        import { connectionToken, hash } from './lib/avc/oauth.ts';
        export default { async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/verify') return Response.json({ tokenHash: await hash(await connectionToken('owner','github')) });
          const name = path.split('/')[3], context = {params: Promise.resolve({provider: name})};
          if (path.endsWith('/callback')) return callback.GET(request, context);
          return request.method === 'POST' ? provider.POST(request,context) : provider.GET(request,context);
        } };`,
        resolveDir: process.cwd(), loader: 'ts',
    }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:zlib', 'node:crypto', 'cloudflare:workers'] });
    const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], script: bundle.outputFiles[0].text, outboundService,
        d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { AVC_AUTH_MODE: 'password', AVC_OAUTH_ORIGIN: 'https://journey.test', AVC_GITHUB_CLIENT_ID: 'github-client', AVC_GITHUB_CLIENT_SECRET: 'github-secret', AVC_GITLAB_CLIENT_ID: 'gitlab-client', AVC_GITLAB_CLIENT_SECRET: 'gitlab-secret', GITHUB_SYNC_KEY: secret },
    });
    try {
        const nativeDB = await runtime.getD1Database('DB');
        for (const statement of readFileSync(new URL('../drizzle/0005_oauth_connections.sql', import.meta.url), 'utf8').split('--> statement-breakpoint')) await nativeDB.prepare(statement).run();
        await nativeDB.prepare('CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,password TEXT,username TEXT)').run();
        await nativeDB.prepare('CREATE TABLE sessions(digest TEXT PRIMARY KEY,user TEXT,expires INTEGER)').run();
        await nativeDB.prepare('CREATE TABLE projects(id TEXT PRIMARY KEY,owner TEXT,name TEXT,version INTEGER,state TEXT,visibility TEXT)').run();
        await nativeDB.prepare('CREATE TABLE agents(digest TEXT PRIMARY KEY,project TEXT,name TEXT,role TEXT)').run();
        await nativeDB.prepare('INSERT INTO users VALUES(?,?,?,?)').bind('owner', 'owner@test', 'unused', 'owner').run();
        await nativeDB.prepare('INSERT INTO users VALUES(?,?,?,?)').bind('other', 'other@test', 'unused', 'other').run();
        await nativeDB.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)').bind('repo', 'owner', 'Repo', 0, '{}', 'public').run();
        await nativeDB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await oauth.hash('native-session'), 'owner', Date.now() + 600_000).run();
        await nativeDB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await oauth.hash('other-session'), 'other', Date.now() + 600_000).run();
        await nativeDB.prepare('INSERT INTO agents VALUES(?,?,?,?)').bind(await oauth.hash('agent-token'), 'repo', 'Agent', 'coordinator').run();
        const call = (path, init = {}) => runtime.dispatchFetch('https://journey.test' + path, { redirect: 'manual', ...init, headers: { Cookie: 'avc_session=native-session', Origin: 'https://journey.test', ...init.headers } });
        for (const headers of [{ Cookie: '' }, { Cookie: 'avc_session=other-session' }, { Authorization: 'Bearer agent-token' }]) {
            const denied = await call('/api/oauth/github?project=repo', { headers }); assert([401, 403].includes(denied.status));
        }
        for (const p of ['github', 'gitlab']) {
            const start = await call(`/api/oauth/${p}`, { method: 'POST', body: JSON.stringify({ project: 'repo' }) });
            assert.equal(start.status, 200); const authorization = new URL((await start.json()).url), state = authorization.searchParams.get('state');
            assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
            const before = await nativeDB.prepare('SELECT verifier FROM oauth_states WHERE digest=?').bind(await oauth.hash(state)).first();
            assert(!before.verifier.includes('native-session')); assert(JSON.parse(before.verifier).ciphertext);
            const changed = await call(`/api/oauth/${p}/callback?state=${state}&code=test-code`, { headers: { Cookie: 'avc_session=other-session' } }); assert.equal(changed.status, 400);
            const replies = await Promise.all([call(`/api/oauth/${p}/callback?state=${state}&code=test-code`), call(`/api/oauth/${p}/callback?state=${state}&code=test-code`)]);
            assert.deepEqual(replies.map(reply => reply.status).sort(), [303, 400]);
            const success = replies.find(reply => reply.status === 303); assert.equal(success.headers.get('Location'), 'https://journey.test/settings?project=repo&oauth=connected');
            const row = await nativeDB.prepare('SELECT credential FROM oauth_connections WHERE user=? AND provider=?').bind('owner', p).first();
            assert(!row.credential.includes('native-private-')); assert(JSON.parse(row.credential).ciphertext);
            const account = await call(`/api/oauth/${p}?project=repo`), value = JSON.stringify(await account.json());
            assert(value.includes('native-user')); assert(!value.includes('native-private-')); assert(!value.includes('credential'));
        }
        assert.equal(exchanges, 2); assert.equal(profiles, 2);
        const verified = await call('/verify'); assert.deepEqual(await verified.json(), { tokenHash: await oauth.hash('native-private-access') });
    } finally { await runtime.dispose(); }
});
