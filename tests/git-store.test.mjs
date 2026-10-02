import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { GitStore, makeCommit, object, decodeObject, concatenate } from '../lib/avc/git.ts';

class MemoryBucket {
    data = new Map();
    writes = [];
    active = 0;
    maximumActive = 0;
    failKey;
    async get(key) {
        const data = this.data.get(key);
        return data ? {
            arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
            text: async () => new TextDecoder().decode(data),
        } : null;
    }
    async put(key, value) {
        this.writes.push(key);
        this.maximumActive = Math.max(this.maximumActive, ++this.active);
        try {
            await new Promise(resolve => setTimeout(resolve, 1));
            if (key === this.failKey) throw new Error('Storage unavailable');
            this.data.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value));
        } finally { this.active--; }
    }
    resetWrites() { this.writes = []; this.maximumActive = 0; }
}

test('one-file integration reuses unchanged objects in a large repository', async () => {
    const bucket = new MemoryBucket(), git = new GitStore(bucket, 'large');
    const files = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`directory-${i % 10}/file-${i}.txt`, `File ${i}\n`]));
    const parent = await git.save(files, undefined, 'Initial', 'Tester');
    const originalEntries = await git.entries(parent.oid);
    bucket.resetWrites();
    const changed = { ...files, 'directory-0/file-0.txt': 'Changed file\n' };
    const integrated = await git.save(changed, parent.oid, 'Integrate approved change', 'Tester');
    const objectWrites = bucket.writes.filter(key => key.includes('/objects/'));
    // One blob, its directory tree, the root tree and the accepted commit.
    assert.equal(objectWrites.length, 4);
    assert.equal(bucket.writes.length, 6);
    assert(bucket.maximumActive > 1 && bucket.maximumActive <= 4);
    assert.equal(bucket.active, 0);
    assert.deepEqual(await git.files(integrated.oid), changed);
    const entries = await git.entries(integrated.oid);
    assert.deepEqual(entries['directory-1/file-1.txt'], originalEntries['directory-1/file-1.txt']);
    assert.equal((await git.read(integrated.oid)).type, 'commit');
    assert.match(new TextDecoder().decode((await git.read(integrated.oid)).body), new RegExp(`parent ${parent.oid}`));
});

test('incremental saves preserve executable, binary, symlink and submodule entries while adding and deleting text', async () => {
    const bucket = new MemoryBucket(), git = new GitStore(bucket, 'modes');
    const binary = await object('blob', Uint8Array.from([0, 1, 2])), symlink = await object('blob', new TextEncoder().encode('run.sh'));
    const special = {
        'run.sh': { mode: '100755', oid: '0'.repeat(40) },
        'binary.bin': { mode: '100644', oid: binary.oid },
        'link': { mode: '120000', oid: symlink.oid },
        'module': { mode: '160000', oid: 'a'.repeat(40) },
    };
    const before = { 'run.sh': '#!/bin/sh\necho before\n', 'deleted.txt': 'Remove me\n', 'same.txt': 'Unchanged\n' };
    const initial = await makeCommit(before, undefined, 'Initial', 'Tester', 1700000000000, special);
    for (const obj of [...initial.objects, binary, symlink]) bucket.data.set(git.key(obj.oid), deflateSync(obj.raw));
    assert.deepEqual({ ...await git.files(initial.oid) }, before);
    const after = { 'run.sh': '#!/bin/sh\necho after\n', 'same.txt': 'Unchanged\n', 'added.txt': 'New\n' };
    const saved = await git.save(after, initial.oid, 'Update', 'Tester');
    const entries = await git.entries(saved.oid);
    assert.equal(entries['run.sh'].mode, '100755');
    assert.equal(entries['deleted.txt'], undefined);
    for (const path of ['binary.bin', 'link', 'module']) assert.deepEqual(entries[path], special[path]);
    assert.deepEqual(await git.files(saved.oid), after);
    assert.equal(await git.entries(initial.oid).then(e => e['deleted.txt'].oid), initial.entries['deleted.txt'].oid);
    await assert.rejects(git.save({ ...after, 'binary.bin': 'Overwrite' }, saved.oid, 'Invalid', 'Tester'), /cannot be edited/);
});

test('object writes are deduplicated and complete before snapshot publication', async () => {
    const bucket = new MemoryBucket(), git = new GitStore(bucket, 'duplicates');
    const saved = await git.save({ 'a.txt': 'Same\n', 'b.txt': 'Same\n' }, undefined, 'Initial', 'Tester');
    const objectWrites = bucket.writes.filter(key => key.includes('/objects/'));
    assert.equal(objectWrites.length, new Set(objectWrites).size);
    const snapshot = bucket.writes.indexOf(`duplicates/snapshots/${saved.oid}`);
    assert(objectWrites.every(key => bucket.writes.indexOf(key) < snapshot));
    for (const key of objectWrites) decodeObject(bucket.data.get(key));
});

test('failed storage writes settle the entire batch and do not publish a snapshot', async () => {
    const bucket = new MemoryBucket(), git = new GitStore(bucket, 'failure');
    bucket.failKey = git.key((await object('blob', new TextEncoder().encode('Fail\n'))).oid);
    await assert.rejects(git.save({ 'a.txt': 'Fail\n', 'b.txt': 'Other\n' }, undefined, 'Initial', 'Tester'), /Storage unavailable/);
    assert.equal(bucket.active, 0);
    assert(!bucket.writes.some(key => key.includes('/snapshots/') || key.includes('/trees/')));
});

test('imported trees with empty directories never reuse nonexistent reconstructed trees', async () => {
    const bucket = new MemoryBucket(), git = new GitStore(bucket, 'imported');
    const encode = text => new TextEncoder().encode(text);
    const blob = await object('blob', encode('Imported\n'));
    const emptyTree = await object('tree', new Uint8Array());
    const root = await object('tree', concatenate(
        encode('100644 README.md\0'), Buffer.from(blob.oid, 'hex'),
        encode('40000 empty\0'), Buffer.from(emptyTree.oid, 'hex'),
    ));
    const parent = await object('commit', encode(`tree ${root.oid}\nauthor Tester <test@example.com> 1700000000 +0000\ncommitter Tester <test@example.com> 1700000000 +0000\n\nImported\n`));
    for (const obj of [blob, emptyTree, root, parent]) bucket.data.set(git.key(obj.oid), deflateSync(obj.raw));
    const files = await git.files(parent.oid);
    const saved = await git.save(files, parent.oid, 'Accepted', 'Tester');
    const tree = /^tree ([a-f0-9]{40})$/m.exec(new TextDecoder().decode((await git.read(saved.oid)).body))[1];
    assert.equal((await git.read(tree)).type, 'tree');
    assert.deepEqual(await git.files(saved.oid), { 'README.md': 'Imported\n' });
});
