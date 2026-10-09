import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { GitStore, object, concatenate, makeCommit } from '../lib/avc/git.ts';
import { importCloudBatch, IMPORT_BATCH } from '../lib/avc/cloud-import.ts';

class Bucket {
    data = new Map(); gets = 0; puts = 0; reads = new Map();
    async get(key) { this.gets++; this.reads.set(key, (this.reads.get(key) ?? 0) + 1); const value = this.data.get(key); return value === undefined ? null : { arrayBuffer: async () => value, text: async () => Buffer.from(value).toString() }; }
    async put(key, value) { this.puts++; this.data.set(key, typeof value === 'string' ? Buffer.from(value) : value); }
}
const certKey = hash => `repo/verified-import-trees/v1/${hash}`;
const workFor = hash => ({ remote: hash, todo: [{ hash, type: 'commit' }], seen: [] });
async function fixture(files) {
    const bucket = new Bucket(), git = new GitStore(bucket, 'repo'), remote = new Map();
    const commit = await makeCommit(files, undefined, 'fixture', 'Owner', 1000);
    for (const entry of commit.objects) remote.set(entry.oid, entry.raw);
    let requests = 0;
    const read = async (hash, type) => { requests++; const raw = remote.get(hash); assert(raw, `missing remote ${hash}`); assert(Buffer.from(raw).toString().startsWith(type + ' ')); return raw.subarray(raw.indexOf(0) + 1); };
    const batch = work => importCloudBatch('repo', bucket, work, new Set(), read, () => {}, Date.now() + 10000);
    const settle = async work => { let checkpoints = 0; do { await batch(work); checkpoints++; } while (work.todo.length); return checkpoints; };
    return { bucket, git, remote, commit, read, batch, settle, requests: () => requests };
}
async function tree(entries) { return object('tree', concatenate(...entries.map(([mode, name, hash]) => concatenate(Buffer.from(`${mode} ${name}\0`), Buffer.from(hash, 'hex'))))); }
async function commitFor(treeHash) { return object('commit', Buffer.from(`tree ${treeHash}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nfixture\n`)); }

test('a wide import batches progress and a verified unchanged tree becomes one read', async () => {
    const f = await fixture(Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`dir/file-${i}`, `value-${i}`])));
    const work = workFor(f.commit.oid), checkpoints = await f.settle(work);
    assert.equal(checkpoints, Math.ceil(455 / IMPORT_BATCH));
    assert.equal(work.todo.length, 0); assert.equal(f.requests(), 453);
    const before = f.bucket.gets, requests = f.requests();
    const replay = workFor(f.commit.oid); assert.equal(await f.settle(replay), 1);
    assert.equal(f.requests(), requests); assert.equal(f.bucket.gets - before, 2, 'one commit GET plus one tree certificate GET; no descendant I/O');
    assert.equal(replay.seen.length, 2);
});

test('stored orphan tree is traversed, missing descendants recovered, and lost checkpoint replay uses completed certificate', async () => {
    const f = await fixture({ 'dir/a': 'a', 'dir/b': 'b' });
    const rootHash = Buffer.from(f.commit.objects.at(-1).raw).toString().match(/tree ([a-f0-9]{40})/)[1];
    await f.bucket.put(f.git.key(rootHash), deflateSync(f.remote.get(rootHash)));
    let fail = true;
    const read = async (hash, type) => { if (type === 'blob' && fail) throw Error('interrupted before descendant'); return f.read(hash, type); };
    const persisted = workFor(f.commit.oid), interrupted = structuredClone(persisted);
    await assert.rejects(importCloudBatch('repo', f.bucket, interrupted, new Set(), read, () => {}, Date.now() + 10000), /interrupted/);
    assert.equal(f.bucket.data.has(certKey(rootHash)), false);
    fail = false; const retry = structuredClone(persisted); await f.settle(retry);
    assert(f.bucket.data.has(certKey(rootHash)));
    const requests = f.requests();
    // Certificate publication succeeded but the D1 checkpoint was lost.
    const replay = structuredClone(persisted); await f.settle(replay);
    assert.equal(f.requests(), requests); assert.equal(replay.todo.length, 0);
});

test('legacy pre-order seen state cannot conceal incomplete closure', async () => {
    const f = await fixture({ a: 'a' }), work = workFor(f.commit.oid);
    work.todo = []; work.seen = f.commit.objects.map(entry => entry.oid);
    await f.settle(work);
    assert.equal(f.requests(), 3); assert.equal(work.importVersion, 1);
});

test('corrupt loose objects and mismatched types fail before certification', async () => {
    for (const mismatch of ['hash', 'type']) {
        const f = await fixture({ a: 'a' }), raw = await object(mismatch === 'type' ? 'blob' : 'commit', Buffer.from('wrong'));
        await f.bucket.put(f.git.key(f.commit.oid), deflateSync(raw.raw));
        await assert.rejects(f.batch(workFor(f.commit.oid)), error => error.code === 'invalid_object');
        assert(![...f.bucket.data.keys()].some(key => key.includes('verified-import-trees')));
    }
});

test('invalid certificate versions and summaries fall back to verified traversal', async () => {
    for (const malformed of ['{', JSON.stringify({ version: 99, depth: 0, path: 0 }), JSON.stringify({ version: 1, depth: -1, path: 0 })]) {
        const f = await fixture({ a: 'a' }), root = Buffer.from(f.commit.objects.at(-1).raw).toString().match(/tree ([a-f0-9]{40})/)[1];
        await f.bucket.put(certKey(root), malformed); await f.settle(workFor(f.commit.oid));
        assert.equal(f.requests(), 3); assert.equal(JSON.parse(Buffer.from(f.bucket.data.get(certKey(root))).toString()).hash, root);
    }
});

test('cached subtrees retain path and depth limits when relocated, including empty trees', async () => {
    const f = await fixture({ ['x'.repeat(990)]: 'a' });
    await f.settle(workFor(f.commit.oid));
    const root = Buffer.from(f.commit.objects.at(-1).raw).toString().match(/tree ([a-f0-9]{40})/)[1];
    const add = obj => { f.remote.set(obj.oid, obj.raw); return obj.oid; };
    const outer = add(await tree([['40000', 'long-directory', root]]));
    const moved = add(await commitFor(outer));
    await assert.rejects(f.settle(workFor(moved)), error => error.code === 'tree_capacity');
    assert(!f.bucket.data.has(certKey(outer)));
    let hash = add(await tree([])); const empty = hash;
    await f.settle(workFor(add(await commitFor(empty))));
    for (let i = 0; i < 41; i++) hash = add(await tree([['40000', 'd', hash]]));
    await assert.rejects(f.settle(workFor(add(await commitFor(hash)))), error => error.code === 'tree_capacity');
});

test('time boundary and aborted execution leave a replayable traversal', async () => {
    const f = await fixture({ a: 'a' }), work = workFor(f.commit.oid);
    await importCloudBatch('repo', f.bucket, work, new Set(), f.read, () => {}, 0);
    assert.equal(f.requests(), 0); assert.equal(work.todo.length, 1);
    await assert.rejects(importCloudBatch('repo', f.bucket, work, new Set(), f.read, () => { throw Error('expired'); }, Date.now() + 10000), /expired/);
    assert.equal(f.requests(), 0); await f.settle(work); assert.equal(work.todo.length, 0);
});

test('an empty directory at the exact 1000-character path boundary remains valid on cache reuse', async () => {
    const f = await fixture({});
    const empty = await tree([]), outer = await tree([['40000', 'x'.repeat(1000), empty.oid]]), root = await commitFor(outer.oid);
    for (const obj of [empty, outer, root]) f.remote.set(obj.oid, obj.raw);
    await f.settle(workFor(root.oid));
    await f.settle(workFor(root.oid));
    const summary = JSON.parse(Buffer.from(f.bucket.data.get(certKey(outer.oid))).toString());
    assert.equal(summary.path, 1000); assert.equal(summary.depth, 1);
});
