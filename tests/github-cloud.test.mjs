import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitStore, object, parseTree, concatenate, makeCommit } from '../lib/avc/git.ts';
import { githubTarget, boundedBytes, oneObjectPack, readCommitPack, packet, GitHubTransport } from '../lib/avc/github-transport.ts';
import { encodeState, decodeState } from '../lib/avc/state-codec.ts';

test('one raw commit preserves signatures, encoding and timezone bytes', async () => {
    const body = Buffer.from(`tree ${'a'.repeat(40)}\nauthor Author <a@b> 100 -0700\ncommitter Author <a@b> 101 -0700\nencoding ISO-8859-1\ngpgsig -----BEGIN PGP SIGNATURE-----\n signed bytes\n -----END PGP SIGNATURE-----\n\nmessage\n`);
    const hash = (await object('commit', body)).oid, pack = await oneObjectPack('commit', body);
    assert.deepEqual(await readCommitPack(pack, hash), body);
    const protocol = concatenate(packet(`shallow ${hash}`), Buffer.from('0000'), packet('NAK\n'), pack);
    assert.deepEqual(await readCommitPack(protocol, hash), body);
    await assert.rejects(readCommitPack(pack.subarray(0, -1), hash));
    const corrupt = Uint8Array.from(pack); corrupt[20] ^= 1;
    await assert.rejects(readCommitPack(corrupt, hash));
    await assert.rejects(readCommitPack(pack, '0'.repeat(40)));
});
test('credential-free exact GitHub target and bounded response rejection', async () => {
    assert.deepEqual(githubTarget('https://github.com/team/repo.git'), { owner: 'team', repo: 'repo' });
    for (const remote of ['https://token@github.com/team/repo', 'https://evil.test/team/repo', 'https://github.com/team/repo?token=x', 'git@github.com:team/repo.git']) assert.throws(() => githubTarget(remote));
    await assert.rejects(boundedBytes(new Response(new Uint8Array(11)), 10), error => error.code === 'sync_capacity');
    const empty = new GitHubTransport({ owner: 'team', repo: 'repo' }, 'token', async () => Response.json({ message: 'Git Repository is empty.' }, { status: 409 }));
    assert.equal(await empty.head('main'), null);
    const denied = new GitHubTransport({ owner: 'team', repo: 'repo' }, 'token', async () => new Response('', { status: 404 }));
    await assert.rejects(denied.authorizeRepository(), error => error.status === 404);
});
test('receive-pack uses an exact old OID and rejects a refused ref update', async () => {
    let command;
    const transport = new GitHubTransport({ owner: 'team', repo: 'repo' }, 'token', async (_url, init) => {
        command = Buffer.from(init.body).toString();
        return new Response('001eunpack ok\n002eng refs/heads/main stale info\n0000');
    });
    await assert.rejects(transport.push('refs/heads/main', '1'.repeat(40), '2'.repeat(40)), error => error.code === 'github_push');
    assert(command.includes(`${'1'.repeat(40)} ${'2'.repeat(40)} refs/heads/main\0report-status\n`));
});
test('an expired execution cannot start a GitHub ref mutation', async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    const transport = new GitHubTransport({ owner: 'team', repo: 'repo' }, 'token', async () => { calls++; return new Response(); }, controller.signal);
    await assert.rejects(transport.push('refs/heads/release+用户', null, '2'.repeat(40)), error => error.name === 'AbortError');
    assert.equal(calls, 0);
});
test('native receive-pack accepts raw signed commit then exact empty-pack ref update', async t => {
    const fixture = mkdtempSync(join(tmpdir(), 'journey-cloud-git-')); t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['--git-dir=' + fixture, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['init', '--bare', '--quiet', fixture]);
    const generated = await makeCommit({ file: 'content\n' }, undefined, 'ignored', 'Owner', 1000);
    for (const entry of generated.objects) {
        const nul = entry.raw.indexOf(0), type = Buffer.from(entry.raw.subarray(0, nul)).toString().split(' ')[0];
        if (type !== 'commit') execFileSync('git', ['--git-dir=' + fixture, 'hash-object', '-w', '-t', type, '--stdin'], { input: entry.raw.subarray(nul + 1) });
    }
    const tree = Buffer.from(generated.objects.at(-1).raw).toString().match(/tree ([a-f0-9]{40})/)[1];
    const body = Buffer.from(`tree ${tree}\nauthor A <a@b> 1 -0700\ncommitter A <a@b> 2 +0530\nencoding ISO-8859-1\ngpgsig -----BEGIN PGP SIGNATURE-----\n preserved bytes\n -----END PGP SIGNATURE-----\n\nmessage\n`);
    const hash = (await object('commit', body)).oid;
    const transport = new GitHubTransport({ owner: 'team', repo: 'repo' }, 'test-token', async (_url, init) => new Response(execFileSync('git', ['receive-pack', '--stateless-rpc', fixture], { input: init.body })));
    let bootstrapPushes = 0, loseBootstrapAck = true;
    const bootstrap = new GitHubTransport({ owner: 'team', repo: 'repo' }, 'test-token', async (url, init = {}) => {
        if (init.method === 'POST') {
            bootstrapPushes++;
            const reply = execFileSync('git', ['receive-pack', '--stateless-rpc', fixture], { input: init.body, stdio: ['pipe', 'pipe', 'pipe'] });
            if (loseBootstrapAck) { loseBootstrapAck = false; throw Error('lost bootstrap acknowledgement'); }
            return new Response(reply);
        }
        const branch = new URL(url).pathname.split('/git/ref/heads/')[1];
        try { return Response.json({ object: { type: 'commit', sha: git('rev-parse', '--verify', 'refs/heads/' + branch).toString().trim() } }); }
        catch { return new Response('', { status: 404 }); }
    });
    await assert.rejects(bootstrap.initializeTransfer('refs/heads/journey-transfer/test/run', async () => undefined), /lost bootstrap/);
    const bootstrapHead = await bootstrap.initializeTransfer('refs/heads/journey-transfer/test/run', async () => undefined);
    assert.equal(bootstrapPushes, 1);
    assert.equal(git('rev-parse', 'refs/heads/journey-transfer/test/run').toString().trim(), bootstrapHead);
    assert.throws(() => git('rev-parse', '--verify', 'refs/heads/main'));
    await transport.push('refs/heads/transfer', null, hash, body);
    await transport.push('refs/heads/main', null, hash);
    git('update-ref', 'refs/heads/journey-transfer/test/run', hash, bootstrapHead);
    await assert.rejects(bootstrap.initializeTransfer('refs/heads/journey-transfer/test/run', async () => undefined), error => error.code === 'conflict_ref_exists');
    assert.equal(git('rev-parse', 'refs/heads/journey-transfer/test/run').toString().trim(), hash); assert.equal(bootstrapPushes, 1);
    assert.deepEqual(git('cat-file', 'commit', hash), body); git('fsck', '--strict', '--no-reflogs');
    const otherBody = Buffer.from(`tree ${tree}\nparent ${hash}\nauthor A <a@b> 3 +0000\ncommitter A <a@b> 3 +0000\n\nremote advance\n`);
    const other = execFileSync('git', ['--git-dir=' + fixture, 'hash-object', '-w', '-t', 'commit', '--stdin'], { input: otherBody }).toString().trim();
    git('update-ref', 'refs/heads/main', other, hash);
    await assert.rejects(transport.push('refs/heads/main', hash, hash), error => error.code === 'github_push');
    assert.equal(git('rev-parse', 'refs/heads/main').toString().trim(), other);
});
test('workerd exposes bounded zlib consumption metadata required by the pack parser', async () => {
    const require = createRequire(import.meta.url);
    const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare', { paths: [require.resolve('wrangler')] })).href);
    const input = Buffer.from('raw exact commit bytes'), compressed = deflateSync(input).toString('base64');
    const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], script: `import { inflateSync } from 'node:zlib'; export default { fetch() { const encoded=Buffer.from('${compressed}', 'base64'); const value=inflateSync(encoded,{info:true,maxOutputLength:8000000}); return Response.json({length:value.buffer.length,consumed:value.engine.bytesWritten,input:encoded.length,text:Buffer.from(value.buffer).toString()}); } };` });
    try {
        const response = await runtime.dispatchFetch('https://probe.test');
        assert.equal(response.status, 200); const value = await response.json();
        assert.equal(value.length, input.length); assert.equal(value.consumed, value.input); assert.equal(value.text, input.toString());
    } finally { await runtime.dispose(); }
});

class Bucket {
    data = new Map(); reads = [];
    async get(key) { this.reads.push(key); const value = this.data.get(key); return value ? { text: async () => Buffer.from(value).toString(), arrayBuffer: async () => Uint8Array.from(value).buffer } : null; }
    async head(key) { return this.data.has(key) ? {} : null; }
    async put(key, value) { this.data.set(key, typeof value === 'string' ? Buffer.from(value) : Uint8Array.from(value)); }
}
test('workerd GitHub transport accepts successful fetches and rejects redirects without forwarding credentials', async () => {
    const require = createRequire(import.meta.url);
    const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare', { paths: [require.resolve('wrangler')] })).href);
    const { build } = await import(pathToFileURL(require.resolve('esbuild', { paths: [require.resolve('wrangler')] })).href);
    const hash = 'a'.repeat(40), token = 'runtime-test-private-token';
    let requests = 0, authenticated = 0, forwarded = 0;
    const statuses = [301, 302, 303, 307, 308];
    // Use a direct mock origin: Miniflare's fetchMock bridge delegates to Node
    // fetch, which can follow a redirect before Workers receives its response.
    const outboundService = async request => {
        const url = new URL(request.url);
        if (url.hostname === 'redirect.example') { forwarded++; return Response.json({}); }
        assert.equal(url.hostname, 'api.github.com'); assert.equal(request.method, 'GET');
        requests++; if (request.headers.get('Authorization') === `Bearer ${token}`) authenticated++;
        if (url.pathname === '/repos/team/repo/git/ref/heads/main') return Response.json({ object: { type: 'commit', sha: hash } });
        const status = Number(url.pathname.match(/\/redirect-(\d+)$/)?.[1]);
        assert(statuses.includes(status));
        return new Response(null, { status, headers: { Location: 'https://redirect.example/credential-trap' } });
    };
    const bundle = await build({ stdin: {
        contents: `import { GitHubTransport } from './lib/avc/github-transport.ts';
        export default { async fetch(request) { const transport=new GitHubTransport({owner:'team',repo:'repo'},'${token}'); try { return Response.json({head:await transport.head(new URL(request.url).pathname.slice(1))}); } catch(error) { return Response.json({code:error.code,message:error.message},{status:502}); } } };`,
        resolveDir: process.cwd(), loader: 'ts',
    }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:zlib'] });
    const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], script: bundle.outputFiles[0].text, outboundService });
    try {
        const success = await runtime.dispatchFetch('https://worker.test/main');
        const successBody = await success.json();
        assert.equal(success.status, 200, JSON.stringify(successBody)); assert.deepEqual(successBody, { head: hash });
        for (const status of statuses) {
            const response = await runtime.dispatchFetch(`https://worker.test/redirect-${status}`);
            assert.equal(response.status, 502); const failure = await response.json();
            assert.equal(failure.code, 'github_request', JSON.stringify({ failure, requests, authenticated, forwarded }));
            assert.match(failure.message, new RegExp(`\\(${status}\\)`)); assert(!JSON.stringify(failure).includes(token));
        }
        assert.equal(requests, 6); assert.equal(authenticated, 6); assert.equal(forwarded, 0);
    } finally { await runtime.dispose(); }
});

test('workerd background sync decrypts repository credentials and observes equal heads through native fetch', async () => {
    const require = createRequire(import.meta.url);
    const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare', { paths: [require.resolve('wrangler')] })).href);
    const { build } = await import(pathToFileURL(require.resolve('esbuild', { paths: [require.resolve('wrangler')] })).href);
    const token = 'background-runtime-private-token', key = 'b'.repeat(64);
    let head, authorized = 0, observed = 0;
    const outboundService = async request => {
        const url = new URL(request.url);
        assert.equal(url.hostname, 'api.github.com'); assert.equal(request.method, 'GET');
        assert.equal(request.headers.get('Authorization'), `Bearer ${token}`);
        if (url.pathname === '/repos/team/repo') { authorized++; return Response.json({ id: 1, full_name: 'team/repo' }); }
        assert.equal(url.pathname, '/repos/team/repo/git/ref/heads/main'); observed++;
        assert(head); return Response.json({ object: { type: 'commit', sha: head } });
    };
    const bundle = await build({ stdin: {
        contents: `import { env } from 'cloudflare:workers';
        import { GitStore } from './lib/avc/git.ts';
        import { storeCredential, runCloudSync, publicSync } from './lib/avc/github-cloud.ts';
        import { encodeState } from './lib/avc/state-codec.ts';
        import { readProject } from './lib/avc/storage.ts';
        export default { async fetch(request) {
            if(new URL(request.url).pathname === '/setup') {
                const initial=await new GitStore(env.BUCKET,'repo').save({file:'runtime fixture'},undefined,'initial','Owner');
                const credential=await storeCredential('repo','${token}','https://github.com/team/repo.git','${key}');
                const state={id:'repo',name:'Repo',head:initial.oid,revisions:{[initial.oid]:initial.meta},journeys:[],leases:[],waiting:[],events:[],sequence:0,integrationCursor:0,generation:0,receipts:{},requireApproval:true,
                    sync:{remote:'https://github.com/team/repo.git',branch:'main',enabled:true,status:'error',error:'prior failed attempt',updatedAt:1,cloud:{credential,generation:'runtime-generation'}}};
                await env.DB.prepare('INSERT INTO projects(id,owner,name,version,state) VALUES(?,?,?,?,?)').bind('repo','owner','Repo',0,encodeState(state)).run();
                return Response.json({head:initial.oid,credential});
            }
            const claimed=await runCloudSync('repo','${key}');
            const state=(await readProject('repo')).state;
            return Response.json({claimed,head:state.head,sync:publicSync(state)});
        } };`,
        resolveDir: process.cwd(), loader: 'ts',
    }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:zlib', 'cloudflare:workers'] });
    const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], script: bundle.outputFiles[0].text,
        d1Databases: { DB: 'runtime-db' }, r2Buckets: ['BUCKET'], outboundService });
    try {
        const db = await runtime.getD1Database('DB');
        await db.prepare('CREATE TABLE projects(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL)').run();
        const setup = await runtime.dispatchFetch('https://worker.test/setup'); assert.equal(setup.status, 200);
        const initial = await setup.json(); head = initial.head;
        const bucket = await runtime.getR2Bucket('BUCKET');
        const encrypted = await (await bucket.get(`repo/cloud-credentials/${initial.credential}`)).text();
        assert(!encrypted.includes(token)); assert.equal(typeof JSON.parse(encrypted).ciphertext, 'string');
        const beforeKeys = (await bucket.list()).objects.map(entry => entry.key).sort();
        const response = await runtime.dispatchFetch('https://worker.test/sync'); assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.claimed, true); assert.equal(result.head, head); assert.equal(result.sync.status, 'idle', JSON.stringify(result));
        assert.equal(result.sync.lastRemoteHead, head); assert.equal(result.sync.lastSyncedHead, head); assert(result.sync.lastCheckedAt > 0);
        assert.equal(result.sync.error, undefined); assert.equal(result.sync.run, undefined); assert.equal(result.sync.progress, null);
        assert(!JSON.stringify(result).includes(token)); assert(!JSON.stringify(result).includes(initial.credential));
        const stored = decodeState((await db.prepare('SELECT state FROM projects WHERE id=?').bind('repo').first()).state);
        assert.equal(stored.sync.cloud.lease, undefined); assert(stored.sync.cloud.nextAttemptAt > Date.now());
        assert.equal(authorized, 1); assert.equal(observed, 1);
        assert.deepEqual((await bucket.list()).objects.map(entry => entry.key).sort(), beforeKeys);
    } finally { await runtime.dispose(); }
});

test('hosted fast-forward import completes without a file/tree snapshot or token disclosure', async t => {
    const bucket = new Bucket(), remoteBucket = new Bucket(), git = new GitStore(bucket, 'repo'), remoteGit = new GitStore(remoteBucket, 'remote');
    const initial = await git.save({ file: 'initial' }, undefined, 'initial', 'Owner');
    for (const [key, value] of bucket.data) if (key.includes('/objects/')) remoteBucket.data.set(key.replace('repo/', 'remote/'), value);
    const incoming = await remoteGit.save({ file: 'incoming' }, initial.oid, 'remote change', 'GitHub');
    const s = { id: 'repo', name: 'Repo', head: initial.oid, revisions: { [initial.oid]: initial.meta }, journeys: [], leases: [], waiting: [], events: [], sequence: 0, integrationCursor: 0, generation: 0, receipts: {}, requireApproval: true };
    s.journeys.push({ id: 'historical-journey', status: 'integrated', reviews: [{ kind: 'approve', revision: initial.oid, resolved: false }], changesets: [] });
    let row = { id: 'repo', owner: 'owner', name: 'Repo', version: 0, state: encodeState(s) };
    const sessions = new Map();
    const db = { projectIds: ['repo'], prepare(sql) { return { bind(...args) { return {
        async first() {
            if (sql.startsWith('SELECT sessions.user,users.email')) return sessions.get(args[0]) ?? null;
            if (sql.startsWith('SELECT owner FROM projects')) return { owner: 'owner' };
            return structuredClone(row);
        },
        async all() { return { results: db.projectIds.filter(id => id > args[0]).slice(0, 100).map(id => ({ id })) }; },
        async run() { assert(sql.startsWith('UPDATE projects SET state=')); if (args[2] !== row.version) return { meta: { changes: 0 } }; row = { ...row, state: args[0], version: row.version + 1 }; return { meta: { changes: 1 } }; },
    }; } }; } };
    globalThis.__cloudTestEnv = { DB: db, BUCKET: bucket };
    const hooks = registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__cloudTestEnv', shortCircuit: true };
        if (specifier.startsWith('@/')) return next(new URL('../' + specifier.slice(2) + '.ts', import.meta.url).href, context);
        if (specifier.startsWith('./lib/avc/')) return next(new URL(specifier + '.ts', context.parentURL).href, context);
        if (specifier === 'vinext/server/fetch-handler') return { url: 'data:text/javascript,export default {fetch:()=>new Response("test")}', shortCircuit: true };
        return next(specifier, context);
    } });
    const originalFetch = globalThis.fetch;
    const refs = new Map([['main', incoming.oid]]); let mainPushes = 0, loseMainAck = false, replaceLeaseDuringRead = false;
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === '/repos/team/repo') return Response.json({ id: 1, full_name: 'team/repo' });
        if (path.includes('/git/ref/heads/')) { const head = refs.get(path.split('/git/ref/heads/')[1]); return head ? Response.json({ object: { sha: head, type: 'commit' } }) : new Response('', { status: 404 }); }
        if (path.endsWith('/info/refs')) return new Response('filter shallow');
        if (path.endsWith('/git-upload-pack')) {
            const hash = /want ([a-f0-9]{40})/.exec(Buffer.from(init.body).toString())[1];
            if (replaceLeaseDuringRead) {
                replaceLeaseDuringRead = false;
                const replacement = decodeState(row.state); replacement.sync.cloud.lease = { token: 'newer-execution', until: Date.now() + 90_000 }; row.state = encodeState(replacement); row.version++;
            }
            return new Response(await oneObjectPack('commit', (await remoteGit.read(hash)).body));
        }
        if (path.endsWith('/git-receive-pack')) {
            const bytes = Buffer.from(init.body), len = parseInt(bytes.subarray(0, 4).toString(), 16);
            const [old, next, ref] = bytes.subarray(4, len).toString().split(/ |\0/);
            const branch = ref.slice('refs/heads/'.length);
            assert.equal(old, refs.get(branch) ?? '0'.repeat(40));
            const pack = bytes.subarray(len + 4);
            if (pack.readUInt32BE(8) === 1) { const body = await readCommitPack(pack, next); await remoteBucket.put(remoteGit.key(next), deflateSync((await object('commit', body)).raw)); }
            refs.set(branch, next);
            if (branch === 'main') { mainPushes++; if (loseMainAck) { loseMainAck = false; throw Error('lost acknowledgement'); } }
            return new Response(concatenate(packet('unpack ok\n'), packet(`ok ${ref}\n`), Buffer.from('0000')));
        }
        if (init.method === 'POST' && /\/git\/(trees|blobs)$/.test(path)) {
            const value = JSON.parse(init.body), type = path.endsWith('/blobs') ? 'blob' : 'tree';
            const body = type === 'blob' ? Buffer.from(value.content, 'base64') : concatenate(...value.tree.map(entry => concatenate(Buffer.from(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, 'hex'))));
            const stored = await object(type, body); await remoteBucket.put(remoteGit.key(stored.oid), deflateSync(stored.raw)); return Response.json({ sha: stored.oid });
        }
        const match = /\/git\/(trees|blobs|commits)\/([a-f0-9]{40})$/.exec(path);
        if (init.method === 'HEAD') return new Response(null, { status: remoteBucket.data.has(remoteGit.key(match[2])) ? 200 : 404 });
        assert(match, `Unexpected request ${path}`); const value = await remoteGit.read(match[2]);
        if (match[1] === 'blobs') return new Response(value.body);
        return Response.json({ sha: match[2], truncated: false, tree: parseTree(value.body).map(entry => ({ path: entry.name, mode: entry.mode === '40000' ? '040000' : entry.mode, sha: entry.oid })) });
    };
    t.after(() => { globalThis.fetch = originalFetch; hooks.deregister(); delete globalThis.__cloudTestEnv; });
    const { storeCredential, runCloudSync, publicSync, scheduledGitHubSync } = await import('../lib/avc/github-cloud.ts');
    const key = 'a'.repeat(64), token = 'github-fine-grained-test-token';
    const credential = await storeCredential('repo', token, 'https://github.com/team/repo.git', key);
    const configured = decodeState(row.state); configured.sync = { remote: 'https://github.com/team/repo.git', branch: 'main', enabled: true, status: 'idle', updatedAt: 1, cloud: { credential, generation: 'generation' } }; row.state = encodeState(configured);
    bucket.reads = [];
    await runCloudSync('repo', key);
    const final = decodeState(row.state);
    assert.equal(final.head, incoming.oid); assert.equal(final.sync.status, 'idle'); assert.equal(final.sync.run, undefined);
    assert.equal(final.sync.lastSyncedHead, incoming.oid);
    assert.equal(final.journeys[0].reviews[0].resolved, false);
    assert(!bucket.reads.some(key => key.includes('/snapshots/') || key.includes('/trees/')));
    assert(!JSON.stringify(publicSync(final)).includes(credential)); assert(!JSON.stringify(final).includes(token));
    const stored = await git.read(incoming.oid); assert.equal((await object('commit', stored.body)).oid, incoming.oid);
    // Journey changes are uploaded by object; a successful GitHub update whose
    // acknowledgement is lost resumes from persisted publish state exactly once.
    const outgoing = await git.save({ file: 'outgoing', added: 'new blob' }, incoming.oid, 'Journey change', 'Worker');
    const changed = decodeState(row.state); changed.head = outgoing.oid; changed.revisions[outgoing.oid] = outgoing.meta; delete changed.sync.cloud.nextAttemptAt; row.state = encodeState(changed);
    loseMainAck = true;
    await runCloudSync('repo', key);
    assert.equal(refs.get('main'), outgoing.oid); assert.equal(decodeState(row.state).sync.status, 'error');
    const retry = decodeState(row.state); delete retry.sync.cloud.nextAttemptAt; row.state = encodeState(retry);
    await runCloudSync('repo', key);
    assert.equal(mainPushes, 1); assert.equal(decodeState(row.state).sync.status, 'idle'); assert.equal(decodeState(row.state).sync.lastSyncedHead, outgoing.oid);
    const advance = await remoteGit.save({ file: 'remote again', added: 'new blob' }, outgoing.oid, 'advance', 'GitHub'); refs.set('main', advance.oid);
    const again = decodeState(row.state); delete again.sync.cloud.nextAttemptAt; row.state = encodeState(again);
    replaceLeaseDuringRead = true;
    await runCloudSync('repo', key);
    const fenced = decodeState(row.state);
    assert.equal(fenced.head, outgoing.oid); assert.equal(fenced.sync.cloud.lease.token, 'newer-execution');
    assert.equal(refs.get('main'), advance.oid); assert.equal(mainPushes, 1);
    await t.test('scheduler fans out every project in bounded batches on each poll', async () => {
        db.projectIds = Array.from({ length: 205 }, (_, i) => 'project-' + i.toString().padStart(3, '0'));
        const batches = [];
        await scheduledGitHubSync({ sendBatch: async batch => { batches.push(batch); } });
        assert.deepEqual(batches.map(batch => batch.length), [100, 100, 5]);
        assert.deepEqual(batches.flat().map(message => message.body.project), db.projectIds);
        assert.equal(Buffer.from(bucket.data.get('cloud-sync/scheduler-cursor')).toString(), '');
        batches.length = 0; await scheduledGitHubSync({ sendBatch: async batch => { batches.push(batch); } });
        assert.equal(batches.flat().length, 205);
    });
    const { digest } = await import('../lib/avc/auth.ts');
    sessions.set(await digest('owner-session'), { user: 'owner', email: 'owner@example.test' });
    sessions.set(await digest('other-session'), { user: 'other', email: 'other@example.test' });
    globalThis.__cloudTestEnv.GITHUB_SYNC_KEY = key;
    const api = await import('../app/api/sync/route.ts');
    const call = async (action, extra = {}, cookie = 'owner-session') => {
        const response = await api.POST(new Request('https://journey.test/api/sync', { method: 'POST', headers: { Cookie: `avc_session=${cookie}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'repo', action, ...extra }) }));
        return { status: response.status, body: await response.json() };
    };
    const diverseFiles = Object.fromEntries(Array.from({ length: 55 }, (_, i) => ['file-' + i, 'unique remote content ' + i]));
    const remoteSibling = await remoteGit.save(diverseFiles, outgoing.oid, 'divergent remote', 'GitHub'); refs.set('main', remoteSibling.oid);
    const localSibling = await git.save({ file: 'local sibling' }, outgoing.oid, 'divergent Journey', 'Worker');
    const diverged = decodeState(row.state); diverged.head = localSibling.oid; diverged.revisions[localSibling.oid] = localSibling.meta;
    delete diverged.sync.run; delete diverged.sync.cloud.work; delete diverged.sync.cloud.lease; delete diverged.sync.cloud.nextAttemptAt;
    row.state = encodeState(diverged);
    const queued = [], worker = (await import('../worker.ts')).default;
    const env = { GITHUB_SYNC_KEY: key, GITHUB_SYNC_QUEUE: { send: async (body, options) => queued.push({ body, options }) } };
    let acknowledged = 0;
    await t.test('large divergence progresses through queue continuations before pausing on preserved heads', async () => {
        const deliver = async () => worker.queue({ messages: [{ body: { project: 'repo' }, ack: () => acknowledged++ }] }, env);
        await deliver();
        assert.equal(decodeState(row.state).head, localSibling.oid);
        assert.equal(decodeState(row.state).sync.cloud.work.phase, 'import');
        assert(queued.length > 0); assert.equal(queued[0].options.delaySeconds, 5);
        for (let turns = 0; turns < 30 && decodeState(row.state).sync.status !== 'conflict'; turns++) await deliver();
        const conflict = decodeState(row.state);
        assert(acknowledged > 2); assert.equal(conflict.sync.status, 'conflict'); assert.equal(conflict.head, localSibling.oid);
        assert.equal(refs.get('main'), remoteSibling.oid); assert.equal(refs.get(conflict.sync.run.conflictBranch), localSibling.oid);
        assert.equal(conflict.sync.run.conflictPublished, true);
    });
    await t.test('reconnect supersedes a generation; cancel and resolution reject an active lease', async () => {
        const active = decodeState(row.state); active.sync.cloud.lease = { token: 'active-old-worker', until: Date.now() + 90_000 }; row.state = encodeState(active);
        const work = structuredClone(active.sync.cloud.work), generation = active.sync.cloud.generation;
        assert.equal((await call('reconnect', { token: 'replacement-github-token' }, 'other-session')).status, 403);
        const connected = await call('reconnect', { token: 'replacement-github-token' }); assert.equal(connected.status, 200);
        assert(!JSON.stringify(connected.body).includes('replacement-github-token'));
        const reconnected = decodeState(row.state); assert.notEqual(reconnected.sync.cloud.generation, generation); assert.deepEqual(reconnected.sync.cloud.work, work);
        assert.equal(reconnected.sync.cloud.lease.token, 'active-old-worker');
        assert.equal((await call('cancel')).status, 409);
        assert.equal((await call('resolve', { runId: reconnected.sync.run.id, head: remoteSibling.oid })).status, 409);
        const restored = structuredClone(reconnected); delete restored.sync.cloud.lease; row.state = encodeState(restored);
        assert.equal((await call('cancel')).status, 200);
        const cancelled = decodeState(row.state); assert.equal(cancelled.sync.enabled, false); assert.equal(cancelled.sync.run, undefined); assert.equal(cancelled.head, localSibling.oid);
        assert.equal(refs.get('main'), remoteSibling.oid); assert.equal(refs.get(restored.sync.run.conflictBranch), localSibling.oid);
        row.state = encodeState(restored);
    });
    await t.test('owner-selected merged GitHub head imports across deliveries without re-publishing', async () => {
        const remoteTree = new TextDecoder().decode((await remoteGit.read(remoteSibling.oid)).body).match(/^tree ([a-f0-9]{40})/m)[1];
        const mergedBody = Buffer.from(`tree ${remoteTree}\nparent ${remoteSibling.oid}\nparent ${localSibling.oid}\nauthor Owner <o@x> 100 +0000\ncommitter Owner <o@x> 100 +0000\n\nresolved merge\n`);
        const merge = await object('commit', mergedBody); await remoteBucket.put(remoteGit.key(merge.oid), deflateSync(merge.raw)); refs.set('main', merge.oid);
        const before = decodeState(row.state);
        assert.equal((await call('resolve', { runId: before.sync.run.id, head: merge.oid })).status, 200);
        assert.equal(decodeState(row.state).sync.run.resolutionHead, merge.oid);
        const pushes = mainPushes;
        const movedBody = Buffer.from(`tree ${remoteTree}\nparent ${merge.oid}\nauthor GitHub <g@x> 101 +0000\ncommitter GitHub <g@x> 101 +0000\n\nmove during resolution\n`);
        const moved = await object('commit', movedBody); await remoteBucket.put(remoteGit.key(moved.oid), deflateSync(moved.raw)); refs.set('main', moved.oid);
        for (let turns = 0; turns < 30 && decodeState(row.state).sync.status !== 'error'; turns++) await worker.queue({ messages: [{ body: { project: 'repo' }, ack() {} }] }, env);
        const paused = decodeState(row.state); assert.equal(paused.head, localSibling.oid); assert.equal(paused.sync.status, 'error'); assert.equal(paused.sync.run.resolutionHead, merge.oid);
        assert.equal(refs.get('main'), moved.oid); assert.equal(mainPushes, pushes);
        assert.equal((await call('resolve', { runId: before.sync.run.id, head: moved.oid })).status, 200);
        for (let turns = 0; turns < 30 && decodeState(row.state).sync.run; turns++) await worker.queue({ messages: [{ body: { project: 'repo' }, ack() {} }] }, env);
        const resolved = decodeState(row.state); assert.equal(resolved.head, moved.oid); assert.equal(resolved.sync.status, 'idle'); assert.equal(resolved.sync.run, undefined);
        assert.equal(mainPushes, pushes); assert.equal(refs.get('main'), moved.oid); assert.equal(refs.get(before.sync.run.conflictBranch), localSibling.oid);
    });
    await t.test('an unreadably deep GitHub tree cannot become the canonical head', async () => {
        const current = decodeState(row.state), blob = await object('blob', Buffer.from('deep content'));
        await remoteBucket.put(remoteGit.key(blob.oid), deflateSync(blob.raw));
        let tree = await object('tree', concatenate(Buffer.from('100644 file\0'), Buffer.from(blob.oid, 'hex')));
        await remoteBucket.put(remoteGit.key(tree.oid), deflateSync(tree.raw));
        for (let depth = 0; depth < 42; depth++) { tree = await object('tree', concatenate(Buffer.from('40000 nested\0'), Buffer.from(tree.oid, 'hex'))); await remoteBucket.put(remoteGit.key(tree.oid), deflateSync(tree.raw)); }
        const commit = await object('commit', Buffer.from(`tree ${tree.oid}\nparent ${current.head}\nauthor A <a@b> 200 +0000\ncommitter A <a@b> 200 +0000\n\ndeep tree\n`));
        await remoteBucket.put(remoteGit.key(commit.oid), deflateSync(commit.raw)); refs.set('main', commit.oid);
        delete current.sync.cloud.nextAttemptAt; row.state = encodeState(current);
        for (let turns = 0; turns < 10 && decodeState(row.state).sync.status !== 'error'; turns++) await runCloudSync('repo', key);
        const rejected = decodeState(row.state); assert.equal(rejected.head, current.head); assert.equal(rejected.sync.status, 'error'); assert.match(rejected.sync.error, /tree depth limit/);
        assert.equal(refs.get('main'), commit.oid);
    });
});
