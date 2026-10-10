import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { GitStore, object, concatenate } from '../lib/avc/git.ts';
import { ancestryCloudBatch } from '../lib/avc/cloud-ancestry.ts';
import { importCloudBatch } from '../lib/avc/cloud-import.ts';
import { exportCloudBatch } from '../lib/avc/cloud-export.ts';
import { wakeIntegratedSync, enqueueIntegratedSync } from '../lib/avc/cloud-wakeup.ts';
class Bucket {
    data = new Map(); reads = 0;
    async get(key) { this.reads++; const value = this.data.get(key); return value ? { arrayBuffer: async () => Uint8Array.from(value).buffer, text: async () => Buffer.from(value).toString() } : null; }
    async put(key, value) { this.data.set(key, typeof value === 'string' ? Buffer.from(value) : Uint8Array.from(value)); }
}
const active = () => {}, deadline = () => Date.now() + 10000;
async function fixture() {
    const bucket = new Bucket(), git = new GitStore(bucket, 'repo');
    const files = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ['wide/file-' + i, 'value-' + i]));
    const root = await git.save(files, undefined, 'root', 'Owner');
    let base = root.oid;
    const tree = new TextDecoder().decode((await git.read(base)).body).match(/^tree (\w+)/)[1];
    for (let i = 0; i < 300; i++) {
        const commit = await object('commit', Buffer.from(`tree ${tree}\nparent ${base}\nauthor A <a@b> ${i} +0000\ncommitter A <a@b> ${i} +0000\n\nhistory ${i}\n`));
        await bucket.put(git.key(commit.oid), deflateSync(commit.raw)); base = commit.oid;
    }
    const remoteObjects = new Set(bucket.data.keys());
    const changed = await git.save({ ...files, 'wide/file-0': 'changed' }, base, 'one edit', 'Owner');
    return { bucket, git, base, changed, files, remoteObjects };
}
test('one changed file after 300 commits proves either fast-forward direction with bounded reads', async () => {
    const { bucket, git, base, changed } = await fixture();
    for (const incoming of [false, true]) {
        bucket.reads = 0;
        const work = { original: incoming ? base : changed.oid, remote: incoming ? changed.oid : base };
        assert.equal(await ancestryCloudBatch(work, git, base, active, deadline()), incoming ? 'incoming' : 'outgoing');
        assert.equal(bucket.reads, 1);
    }
});
test('divergence prunes shared long history but retains alternate merge parents and handles rewinds', async () => {
    const { bucket, git, base, changed, files } = await fixture();
    const other = await git.save({ ...files, extra: 'other' }, base, 'other', 'Owner');
    bucket.reads = 0;
    assert.equal(await ancestryCloudBatch({ original: changed.oid, remote: other.oid }, git, base, active, deadline()), 'diverged');
    assert.equal(bucket.reads, 2);
    const tree = new TextDecoder().decode((await git.read(other.oid)).body).match(/^tree (\w+)/)[1];
    const merge = await object('commit', Buffer.from(`tree ${tree}\nparent ${base}\nparent ${changed.oid}\nauthor A <a@b> 400 +0000\ncommitter A <a@b> 400 +0000\n\nmerge\n`));
    await bucket.put(git.key(merge.oid), deflateSync(merge.raw));
    assert.equal(await ancestryCloudBatch({ original: changed.oid, remote: merge.oid }, git, base, active, deadline()), 'incoming');
    assert.equal(await ancestryCloudBatch({ original: base, remote: changed.oid }, git, changed.oid, active, deadline()), 'incoming');
});
test('ancestry resumes old persisted phases and interruption without guessing a direction', async () => {
    const { git, base, changed } = await fixture();
    const work = { original: changed.oid, remote: base, phase: 'remote-ancestry', todo: [], seen: [base] };
    await assert.rejects(ancestryCloudBatch(work, git, base, () => { throw Error('lease lost'); }, deadline()), /lease lost/);
    assert.equal(await ancestryCloudBatch(JSON.parse(JSON.stringify(work)), git, base, active, deadline()), 'outgoing');
});
test('wide outgoing edit probes only changed objects, and interrupted replay recovers exact scratch commit', async () => {
    const { git, base, changed, remoteObjects } = await fixture();
    let head = null, probes = 0, writes = 0, pushes = 0;
    const remote = {
        has: async hash => { probes++; return remoteObjects.has(git.key(hash)); },
        head: async () => head,
        write: async hash => { writes++; remoteObjects.add(git.key(hash)); },
        push: async (_ref, old, hash) => { assert.equal(old, head); pushes++; head = hash; remoteObjects.add(git.key(hash)); },
    };
    const initial = { original: changed.oid, remote: base, todo: [{ hash: changed.oid, type: 'commit' }], seen: [] };
    const work = structuredClone(initial);
    await exportCloudBatch(work, git, remote, 'scratch', active, async () => {}, deadline());
    assert.equal(work.todo.length, 0); assert.equal(head, changed.oid);
    assert(probes <= 4, `remote probes ${probes}`); assert.equal(writes, 3); assert.equal(pushes, 1);
    // Simulate losing the ENTIRE D1 checkpoint after the scratch ref advanced.
    await exportCloudBatch(initial, git, remote, 'scratch', active, async () => {}, deadline());
    assert.equal(initial.transferHead, changed.oid); assert.equal(initial.todo.length, 0); assert.equal(pushes, 1);
});
test('export persists one commit at a time and refuses lease loss and ref replacement', async () => {
    const { git, base, changed, remoteObjects } = await fixture();
    const second = await git.save({ x: 'second' }, changed.oid, 'second', 'Owner');
    let head = null, pushes = 0, owned = true;
    const remote = {
        has: async hash => remoteObjects.has(git.key(hash)), head: async () => head,
        write: async hash => remoteObjects.add(git.key(hash)),
        push: async (_ref, old, hash) => { assert.equal(old, head); pushes++; head = hash; remoteObjects.add(git.key(hash)); },
    };
    const work = { original: second.oid, remote: base, todo: [], seen: [] };
    await exportCloudBatch(work, git, remote, 'scratch', active, async () => { assert(owned); }, deadline());
    assert.equal(pushes, 1); assert.equal(head, changed.oid); assert(work.todo.length);
    const saved = structuredClone(work); owned = false;
    await assert.rejects(exportCloudBatch(work, git, remote, 'scratch', active, async () => { assert(owned, 'lease lost'); }, deadline()), /lease lost/);
    assert.equal(pushes, 1);
    head = 'a'.repeat(40); owned = true;
    await assert.rejects(exportCloudBatch(saved, git, remote, 'scratch', active, async () => {}, deadline()), error => error.code === 'conflict_ref_exists');
    assert.equal(pushes, 1);
});
test('integration removes only successful polling cooldown; queue failure cannot fail committed integration', async () => {
    const state = { sync: { enabled: true, status: 'idle', cloud: { generation: 'g', nextAttemptAt: Date.now() + 240000 } } };
    assert.equal(wakeIntegratedSync(state), true); assert.equal(state.sync.cloud.nextAttemptAt, undefined);
    for (const changes of [{ status: 'error' }, { status: 'idle', cloud: { failures: 1, nextAttemptAt: 100 } }, { run: {} }, { enabled: false }]) {
        const paused = structuredClone(state); Object.assign(paused.sync, changes); assert.equal(wakeIntegratedSync(paused), false);
        if (changes.cloud) assert.equal(paused.sync.cloud.nextAttemptAt, 100);
    }
    let sent;
    await enqueueIntegratedSync('repo', { send: async (...args) => { sent = args; } });
    assert.deepEqual(sent, [{ project: 'repo' }, { delaySeconds: 0 }]);
    await enqueueIntegratedSync('repo', { send: async () => { throw Error('queue unavailable'); } });
});

test('one incoming edit in 2000 files reuses canonical blobs with bounded reads', async () => {
    const { bucket, git, base, changed, remoteObjects } = await fixture();
    const remoteBucket = new Bucket(); remoteBucket.data = new Map(bucket.data);
    const remoteGit = new GitStore(remoteBucket, 'repo');
    for (const key of bucket.data.keys()) if (!remoteObjects.has(key)) bucket.data.delete(key);
    bucket.reads = 0;
    let fetches = 0;
    const work = { remote: changed.oid, todo: [], seen: [] };
    await importCloudBatch('repo', bucket, work, new Set([base]), async hash => { fetches++; return (await remoteGit.read(hash)).body; }, active, deadline(), base);
    assert.equal(work.todo.length, 0); assert(bucket.reads <= 15, `local reads ${bucket.reads}`); assert.equal(fetches, 4);
    assert.equal((await git.read(changed.oid)).type, 'commit');
});
test('baseline blob reuse builds exact subtree certificates and rejects deeper relocated reuse', async () => {
    const bucket = new Bucket(), git = new GitStore(bucket, 'repo');
    const files = { ['n/'.repeat(40) + 'file']: 'same blob' };
    const base = await git.save(files, undefined, 'deep baseline', 'Owner');
    const changed = await git.save({ ...files, extra: 'new' }, base.oid, 'new root blob', 'Owner');
    assert(![...bucket.data.keys()].some(key => key.includes('verified-import-trees')));
    const work = { remote: changed.oid, todo: [], seen: [] };
    for (let i = 0; i < 3 && (i === 0 || work.todo.length); i++) await importCloudBatch('repo', bucket, work, new Set([base.oid]), async () => { throw Error('local objects should suffice'); }, active, deadline(), base.oid);
    assert.equal(work.todo.length, 0);
    const root = new TextDecoder().decode((await git.read(changed.oid)).body).match(/^tree (\w+)/)[1];
    const summary = JSON.parse(Buffer.from(bucket.data.get(`repo/verified-import-trees/v1/${root}`)).toString());
    assert.equal(summary.depth, 40);
    const tree = await object('tree', concatenate(Buffer.from('40000 moved\0'), Buffer.from(root, 'hex')));
    await bucket.put(git.key(tree.oid), deflateSync(tree.raw));
    const commit = await object('commit', Buffer.from(`tree ${tree.oid}\nparent ${changed.oid}\nauthor A <a@b> 500 +0000\ncommitter A <a@b> 500 +0000\n\nmoved\n`));
    await bucket.put(git.key(commit.oid), deflateSync(commit.raw));
    const moved = { remote: commit.oid, todo: [], seen: [] };
    await assert.rejects(importCloudBatch('repo', bucket, moved, new Set([changed.oid]), async () => { throw Error('not fetched'); }, active, deadline(), changed.oid), error => error.code === 'tree_capacity');
});
test('batched ancestry exposes bounded progress without leaking frontier hashes', async () => {
    const { syncView } = await import('../lib/avc/sync-view.ts');
    const result = syncView({ status: 'running', cloud: { work: { phase: 'remote-ancestry', todo: ['old'], seen: [], ancestry: { incoming: ['private-a'], outgoing: ['private-b'], incomingSeen: ['private-c'], outgoingSeen: ['private-d'] } } } });
    assert.deepEqual(result.progress, { phase: 'remote-ancestry', objects: 2, pending: 2 });
    assert(!JSON.stringify(result).includes('private-'));
});
