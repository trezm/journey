import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GitStore, object } from '../lib/avc/git.ts';
import { pendingIntegrations, validateSubmission } from '../lib/avc/core.ts';
import { assertSyncWritable, beginSync, completeSync, configureSync, conflictSync, prepareSync, resolveSync, stageSync } from '../lib/avc/sync.ts';
import { syncBody, syncTree, trustedSyncHeads, verifySyncClosure } from '../lib/avc/sync-git.ts';

const owner = { id: 'owner', agent: false }, coordinator = { id: 'agent:coordinator', agent: true, role: 'coordinator' };
const sha = n => n.toString(16).padStart(40, '0');
function state(head = sha(1)) {
    return { id: 'repo', name: 'Repo', head, revisions: { [head]: { message: 'Initial', actor: 'Owner', at: 1 } }, journeys: [], leases: [], waiting: [], events: [], sequence: 0, integrationCursor: 0, generation: 0, receipts: {}, requireApproval: true };
}
function journey(s, id = 'journey') {
    const j = { id, title: id, description: id, actor: 'worker', status: 'review', posted: true, base: s.head, head: sha(8), reconciledHead: s.head, reconciledCursor: s.integrationCursor, changesets: [{ id: 'step', description: 'Work', patches: [{}] }], manifest: [], manifestDeclared: true, reviews: [{ kind: 'approve', revision: sha(8), resolved: false }], dispositions: {}, created: 1 };
    s.journeys.push(j); return j;
}
function lease(s, id, path, start, end, whole = false, holder = 'journey') {
    const l = { id, token: 'token-' + id, generation: ++s.generation, journey: holder, changeset: 'step', revision: sha(8), path, start: start + 1, end, canonicalStart: start, canonicalEnd: end, whole, expires: 253402300799999, retained: true };
    s.leases.push(l); return l;
}
function tree(files, modes = {}) { return { files, entries: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { oid: Buffer.from(content).toString('hex'), mode: modes[path] ?? '100644' }])) }; }
function start(s, remoteHead = sha(2), id = 'run-000001') {
    configureSync(s, { remote: 'https://example.com/project.git', branch: 'main', enabled: true }, owner);
    return beginSync(s, { runId: id, expectedHead: s.head, remoteHead, expectedRemote: s.sync.remote, expectedBranch: s.sync.branch }, coordinator);
}

test('configuration rejects malformed SSH addresses the runner cannot execute', () => {
    for (const remote of ['-git@example.com:repo.git', 'git@-example.com:repo.git', 'git@example.com:repo$bad.git', 'git@example.com:repo;bad.git', 'ssh://-git@example.com/repo.git', 'ssh://git@-example.com/repo.git', 'ssh://bad%20user@example.com/repo.git']) {
        assert.throws(() => configureSync(state(), { remote, branch: 'main', enabled: true }, owner), error => error.code === 'invalid_remote', remote);
    }
    for (const remote of ['git@example.com:owner/repo.git', 'git@example.com:/srv/repo.git', 'ssh://git@example.com:2222/owner/repo.git', 'https://example.com/owner/repo.git']) {
        assert.doesNotThrow(() => configureSync(state(), { remote, branch: 'main', enabled: true }, owner), remote);
    }
});

test('incoming changes invalidate overlapping grants before rebase, preserving other paths and audit', () => {
    const s = state(), j = journey(s), original = tree({ 'a.txt': 'a\nb\nc\nd\ne', 'other.txt': 'same' });
    const remote = tree({ 'a.txt': 'a\nB\nc\nd\ne', 'other.txt': 'same' });
    lease(s, 'touched', 'a.txt', 1, 2); lease(s, 'untouched', 'a.txt', 4, 5); lease(s, 'other', 'other.txt', 0, 1, true);
    const priorHead = j.head, run = start(s);
    prepareSync(s, run, sha(1), original, remote, original);
    assert.deepEqual(s.leases.map(l => l.id), ['untouched', 'other']);
    assert.equal(j.head, priorHead); assert.equal(j.changesets.length, 1); assert.equal(j.reviews[0].resolved, true);
    assert(s.events.some(e => e.type === 'lock.invalidated' && e.targets.includes(j.id)));
    assert.throws(() => assertSyncWritable(s, 'acquire'), e => e.code === 'sync_paused');
    assert.doesNotThrow(() => assertSyncWritable(s, 'refresh'));
    assert.doesNotThrow(() => stageSync(s, run, sha(2), {}));
});

test('ambiguous base-to-main mapping and nontext or mode changes revoke the affected path conservatively', () => {
    const s = state(), j = journey(s), base = tree({ f: 'old\nsecond', mode: 'same', other: 'same' }), original = tree({ f: 'local\nsecond', mode: 'same', other: 'same' });
    const incoming = tree({ f: 'remote\nsecond', mode: 'same', other: 'same' }, { mode: '100755' });
    lease(s, 'f', 'f', 1, 2); lease(s, 'mode', 'mode', 0, 1); lease(s, 'other', 'other', 0, 1);
    const run = start(s); prepareSync(s, run, sha(7), original, incoming, base);
    assert.deepEqual(s.leases.map(l => l.id), ['other']); assert.equal(j.head, sha(8));
});

test('completion remaps unaffected ranges, revokes additional overlaps, marks exact approvals stale and requires reconciliation', () => {
    const s = state(), j = journey(s), original = tree({ f: 'a\nb\nc\nd\ne', g: 'old' }), incoming = tree({ f: 'a\nb\nc\nd\ne', g: 'remote' });
    lease(s, 'range', 'f', 3, 5); lease(s, 'whole', 'g', 0, 1, true);
    const run = start(s); prepareSync(s, run, sha(1), original, incoming, original);
    const candidate = tree({ f: 'new\na\nb\nc\nd\ne', g: 'remote' });
    stageSync(s, run, sha(3), { [sha(1)]: sha(3) });
    const result = completeSync(s, run, original, candidate, { parent: sha(2), message: 'Rebased', actor: 'Original', at: 2 });
    assert.equal(result.head, sha(3)); assert.equal(s.sync.run, undefined); assert.equal(s.sync.status, 'idle');
    assert.equal(s.sync.backupRefs['refs/heads/journey-sync/run-000001/original'], sha(1));
    assert.equal(s.leases.length, 1); assert.equal(s.leases[0].canonicalStart, 4); assert.equal(s.leases[0].canonicalEnd, 6);
    assert.equal(j.base, sha(1)); assert.equal(j.head, sha(8)); assert.equal(j.reviews[0].resolved, true);
    const [event] = pendingIntegrations(s, j); assert.equal(event.type, 'repository.synced'); assert.equal(event.id, s.integrationCursor);
    assert.throws(() => validateSubmission(s, j), e => e.code === 'reconciliation_required');
    assert.doesNotThrow(() => assertSyncWritable(s)); assert(s.revisions[sha(1)]);
});

test('conflicts freeze refresh as well, preserve originals and accept only the owner-selected resolution', () => {
    const s = state(), run = start(s); conflictSync(s, run, ['f']);
    assert.throws(() => assertSyncWritable(s, 'refresh'), e => e.code === 'sync_paused');
    assert.throws(() => resolveSync(s, run, sha(3), coordinator), e => e.code === 'forbidden');
    resolveSync(s, run, sha(3), owner); stageSync(s, run, sha(3), {});
    resolveSync(s, run, sha(4), owner);
    assert.equal(run.candidate, undefined); assert.equal(run.phase, 'resolving');
    assert.equal(s.sync.backupRefs[`refs/heads/journey-sync/${run.id}/resolution-${sha(3)}`], sha(3));
    assert.throws(() => stageSync(s, run, sha(3), {}), e => e.code === 'resolution_changed');
    assert.equal(stageSync(s, run, sha(4), {}).candidate, sha(4));
});

test('bounded streaming rejects an oversized body without trusting Content-Length', async () => {
    const request = new Request('http://localhost/sync', { method: 'POST', body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); controller.close(); } }), duplex: 'half' });
    await assert.rejects(syncBody(request, 5), e => e.code === 'request_too_large');
});

class MemoryBucket {
    data = new Map();
    async get(key) { const value = this.data.get(key); return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength), text: async () => new TextDecoder().decode(value), body: value } : null; }
    async put(key, value) { this.data.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)); }
}

test('real sync routes authorize, validate raw commits, fence racing mutations and recover lost responses', async t => {
    const checkout = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const envModule = 'data:text/javascript,' + encodeURIComponent('export const env = globalThis.__syncTestEnvironment;');
    const hooks = registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'cloudflare:workers') return { url: envModule, shortCircuit: true };
        if (specifier.startsWith('@/')) return next(pathToFileURL(checkout + '/' + specifier.slice(2) + '.ts').href, context);
        return next(specifier, context);
    } });
    const db = { rows: new Map(), agents: new Map(), sessions: new Map(), beforeUpdate: null, prepare(sql) { return { bind(...args) { return {
        async first() {
            if (sql.startsWith('SELECT id,owner,name,visibility,version,state FROM projects')) return structuredClone(db.rows.get(args[0]) ?? null);
            if (sql.startsWith('SELECT username FROM users')) return { username: 'owner' };
            if (sql.startsWith('SELECT owner FROM projects')) return db.rows.has(args[0]) ? { owner: db.rows.get(args[0]).owner } : null;
            if (sql.startsWith('SELECT project,name,role FROM agents')) return db.agents.get(args[0]) ?? null;
            if (sql.startsWith('SELECT sessions.user,users.email')) return db.sessions.get(args[0]) ?? null;
            throw Error('Unhandled query: ' + sql);
        },
        async run() {
            if (sql.startsWith('UPDATE projects SET state=')) {
                if (db.beforeUpdate) { const hook = db.beforeUpdate; db.beforeUpdate = null; hook(); }
                const row = db.rows.get(args[1]); if (row.version !== args[2]) return { meta: { changes: 0 } };
                row.state = args[0]; row.version++; return { meta: { changes: 1 } };
            }
            throw Error('Unhandled write: ' + sql);
        },
    }; } }; } };
    const bucket = new MemoryBucket(); globalThis.__syncTestEnvironment = { DB: db, BUCKET: bucket };
    t.after(() => { hooks.deregister(); delete globalThis.__syncTestEnvironment; });
    const sync = await import('../app/api/sync/route.ts'), avc = await import('../app/api/avc/route.ts'), importing = await import('../app/api/import/route.ts');
    const gitRoute = await import('../app/api/git/[project]/[...path]/route.ts');
    const { digest } = await import('../lib/avc/auth.ts'), { decodeState, encodeState } = await import('../lib/avc/state-codec.ts');
    const tokens = { coordinator: 'avc_sync_coordinator', otherCoordinator: 'avc_other_coordinator', worker: 'avc_sync_worker' };
    for (const [name, token] of Object.entries(tokens)) db.agents.set(await digest(token), { project: 'repo', name, role: name === 'worker' ? 'worker' : 'coordinator' });
    db.sessions.set(await digest('owner-session'), { user: 'owner', username: 'owner', email: 'owner@example.test' });
    const headers = who => who === 'owner' ? { Cookie: 'avc_session=owner-session' } : { Authorization: 'Bearer ' + tokens[who] };
    const git = new GitStore(bucket, 'repo'), initial = await git.save({ 'file.txt': 'one\ntwo\nthree', 'stable.txt': 'stable' }, undefined, 'Initial', 'Owner');
    const s = state(initial.oid); s.revisions[initial.oid] = initial.meta;
    db.rows.set('repo', { id: 'repo', owner: 'owner', name: 'Repo', version: 0, state: encodeState(s) });
    const read = () => decodeState(db.rows.get('repo').state);
    const write = fn => { const row = db.rows.get('repo'), s = decodeState(row.state); fn(s); row.state = encodeState(s); row.version++; };
    async function call(action, data = {}, who = 'coordinator', expected = 200, code) {
        const response = await sync.POST(new Request('http://localhost/api/sync', { method: 'POST', headers: { ...headers(who), 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'repo', action, ...(action === 'begin' ? { expectedRemote: read().sync.remote, expectedBranch: read().sync.branch } : {}), ...data }) }));
        const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); if (code) assert.equal(body.code, code); return body.result ?? body;
    }
    async function mutation(action, data = {}, expected = 409) {
        const response = await avc.POST(new Request('http://localhost/api/avc', { method: 'POST', headers: { ...headers('coordinator'), 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'repo', requestId: crypto.randomUUID(), action, ...data }) }));
        assert.equal(response.status, expected); return response.json();
    }
    const runId = 'http-run-0001';
    await call('configure', { remote: 'https://token@example.com/repo', branch: 'main', enabled: true }, 'owner', 400, 'invalid_remote');
    await call('configure', { remote: 'https://example.com/repo', branch: 'main', enabled: true }, 'coordinator', 403, 'forbidden');
    await call('configure', { remote: 'https://example.com/repo', branch: 'main', enabled: true }, 'owner');
    await call('begin', { runId: 'wrong-target', expectedHead: initial.oid, remoteHead: initial.oid, expectedRemote: 'https://example.com/previous-repo' }, 'coordinator', 409, 'sync_target_changed');
    await call('begin', { runId: 'wrong-branch', expectedHead: initial.oid, remoteHead: initial.oid, expectedBranch: 'previous-main' }, 'coordinator', 409, 'sync_target_changed');
    const observedSequence = read().sequence;
    await call('observe', { head: initial.oid, expectedRemote: 'https://example.com/repo', expectedBranch: 'main' });
    assert.equal(read().sync.lastSyncedHead, initial.oid); assert(read().sync.lastCheckedAt); assert.equal(read().sequence, observedSequence);
    await call('observe', { head: sha(123), expectedRemote: 'https://example.com/repo', expectedBranch: 'main' }, 'coordinator', 409, 'stale_sync');
    const incoming = await git.save({ 'file.txt': 'one\nREMOTE\nthree', 'stable.txt': 'stable' }, initial.oid, 'Remote', 'Remote author');
    await call('begin', { runId, expectedHead: initial.oid, remoteHead: incoming.oid }, 'worker', 403, 'forbidden');
    await call('begin', { runId, expectedHead: initial.oid, remoteHead: incoming.oid });
    await call('observe', { head: initial.oid, expectedRemote: 'https://example.com/repo', expectedBranch: 'main' }, 'coordinator', 409, 'sync_paused');
    assert.equal((await mutation('create_journey', { title: 'Blocked' })).code, 'sync_paused');
    await call('configure', { remote: 'https://example.com/other', branch: 'main', enabled: true }, 'owner', 409, 'sync_paused');
    await call('prepare', { runId, base: initial.oid }, 'otherCoordinator', 403, 'sync_run_owned');
    const frozenImport = await importing.POST(new Request('http://localhost/api/import?project=repo&op=start', { method: 'POST', headers: headers('coordinator') }));
    assert.equal(frozenImport.status, 409); assert.equal((await frozenImport.json()).code, 'sync_paused');
    await call('prepare', { runId, base: initial.oid });
    await call('stage', { runId, head: incoming.oid, rewrites: {} });
    await call('complete', { runId, head: initial.oid }, 'coordinator', 409, 'sync_candidate_changed');
    const result = await call('complete', { runId, head: incoming.oid }); assert.equal(result.head, incoming.oid);
    assert.deepEqual(await call('complete', { runId, head: incoming.oid }), read().sync.receipts[runId]);
    assert.equal((await call('begin', { runId, expectedHead: initial.oid, remoteHead: incoming.oid })).completed, true);
    assert.equal(read().head, incoming.oid); assert(read().revisions[initial.oid]);
    assert(read().events.some(e => e.type === 'repository.synced' && e.data.revision === incoming.oid));
    const refs = await gitRoute.GET(new Request('http://localhost/api/git/repo/info/refs', { headers: headers('coordinator') }), { params: Promise.resolve({ project: 'repo', path: ['info', 'refs'] }) });
    assert.match(await refs.text(), new RegExp(initial.oid + '\\trefs/heads/journey-sync/' + runId + '/original'));

    // A sync beginning between read and CAS must block the retried mutation, not just initial requests.
    db.beforeUpdate = () => write(s => beginSync(s, { runId: 'cas-run-0001', expectedHead: s.head, remoteHead: incoming.oid, expectedRemote: s.sync.remote, expectedBranch: s.sync.branch }, owner));
    assert.equal((await mutation('create_journey', { title: 'Racing sync' })).code, 'sync_paused');
    assert.equal(read().journeys.length, 0);
    await call('prepare', { runId: 'cas-run-0001', base: incoming.oid }, 'owner');
    await call('stage', { runId: 'cas-run-0001', head: incoming.oid }, 'owner');
    await call('complete', { runId: 'cas-run-0001', head: incoming.oid }, 'owner');

    // Raw remote commit bytes remain unchanged. Incomplete histories never become advertised refs.
    const current = read().head, rawCommit = await object('commit', new TextEncoder().encode(`tree ${sha(900)}\nparent ${current}\nauthor External <x@example.test> 123 +0000\ncommitter External <x@example.test> 123 +0000\n\nExact original metadata\n`));
    const rawRun = 'raw-run-0001'; await call('begin', { runId: rawRun, expectedHead: current, remoteHead: rawCommit.oid });
    const compressed = deflateSync(rawCommit.raw), frame = Buffer.alloc(44); frame.write(rawCommit.oid); frame.writeUInt32BE(compressed.length, 40);
    const upload = await sync.POST(new Request('http://localhost/api/sync?project=repo&op=objects&run=' + rawRun, { method: 'POST', headers: headers('coordinator'), body: Buffer.concat([frame, compressed]) }));
    assert.equal(upload.status, 200); assert.deepEqual((await git.read(rawCommit.oid)).raw, Buffer.from(rawCommit.raw));
    await call('prepare', { runId: rawRun, base: current }, 'coordinator', 404, 'object_missing');
    assert.equal(read().sync.backupRefs[`refs/heads/journey-sync/${rawRun}/remote`], undefined);
    assert.equal(read().head, current);
    frame.write(sha(999));
    const badUpload = await sync.POST(new Request('http://localhost/api/sync?project=repo&op=objects&run=' + rawRun, { method: 'POST', headers: headers('coordinator'), body: Buffer.concat([frame, compressed]) }));
    assert.equal(badUpload.status, 400); assert.equal((await badUpload.json()).code, 'hash_mismatch');
    const malformedFrame = Buffer.alloc(44); malformedFrame.write(sha(998)); malformedFrame.writeUInt32BE(3, 40);
    const malformed = await sync.POST(new Request('http://localhost/api/sync?project=repo&op=objects&run=' + rawRun, { method: 'POST', headers: headers('coordinator'), body: Buffer.concat([malformedFrame, Buffer.from([1, 2, 3])]) }));
    assert.equal(malformed.status, 400); assert.equal((await malformed.json()).code, 'invalid_object');

    // Pauses survive errors, branch-publish failure stays separate, and owner can replace stale resolution SHA.
    await call('conflict', { runId: rawRun, files: ['file.txt'] });
    await call('conflict_published', { runId: rawRun, published: false, error: 'secret must not persist' });
    await call('fail', { runId: rawRun, error: 'secret must not persist' });
    assert.equal(read().sync.run.phase, 'conflict'); assert(!JSON.stringify(read().sync).includes('secret must not persist'));
    await call('resolve', { runId: rawRun, head: incoming.oid }, 'coordinator', 403, 'forbidden');
    await call('resolve', { runId: rawRun, head: incoming.oid }, 'owner');
    await call('stage', { runId: rawRun, head: incoming.oid });
    const resolution = await git.save({ 'file.txt': 'Resolved', 'stable.txt': 'stable' }, incoming.oid, 'Manual resolution', 'Owner');
    await call('resolve', { runId: rawRun, head: resolution.oid }, 'owner');
    await call('complete', { runId: rawRun, head: incoming.oid }, 'coordinator', 409, 'sync_not_staged');
    await call('stage', { runId: rawRun, head: incoming.oid }, 'coordinator', 409, 'resolution_changed');
    await call('stage', { runId: rawRun, head: resolution.oid });
    await call('complete', { runId: rawRun, head: incoming.oid }, 'coordinator', 409, 'sync_candidate_changed');
    await call('complete', { runId: rawRun, head: resolution.oid });
    assert.equal(read().head, resolution.oid); assert.equal(read().sync.status, 'idle');

    const restartRun = 'restart-0001', next = await git.save({ 'file.txt': 'Remote advanced', 'stable.txt': 'stable' }, resolution.oid, 'Advance', 'Owner');
    await call('begin', { runId: restartRun, expectedHead: resolution.oid, remoteHead: resolution.oid });
    await call('prepare', { runId: restartRun, base: resolution.oid }); await call('stage', { runId: restartRun, head: resolution.oid });
    await call('restart', { runId: restartRun, observedRemoteHead: resolution.oid }, 'coordinator', 409, 'sync_retry_required');
    await call('restart', { runId: restartRun, observedRemoteHead: next.oid });
    assert.equal((await call('restart', { runId: restartRun, observedRemoteHead: next.oid })).restarted, true);
    assert.equal(read().head, resolution.oid); assert.equal(read().sync.backupRefs[`refs/heads/journey-sync/${restartRun}/candidate`], resolution.oid);

    // Existing verified histories form incremental closure boundaries, and external snapshots remain readable.
    await verifySyncClosure(git, next.oid, trustedSyncHeads(read()));
    assert.deepEqual((await syncTree(git, next.oid)).files, { 'file.txt': 'Remote advanced', 'stable.txt': 'stable' });
});
