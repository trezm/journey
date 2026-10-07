import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { GitStore, makeCommit, object, decodeObject, concatenate } from '../lib/avc/git.ts';
import { mergeFiles } from '../lib/avc/core.ts';

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

test('reconciling after remote sync inherits external binaries, modes, symlinks and deletions while keeping journey ancestry', async () => {
    const bucket = new MemoryBucket(), git = new GitStore(bucket, 'external-sync');
    const encoder = new TextEncoder();
    const binary = await object('blob', Uint8Array.from([0, 1, 2]));
    const nextBinary = await object('blob', Uint8Array.from([0, 3, 4]));
    const link = await object('blob', encoder.encode('before.txt'));
    const nextLink = await object('blob', encoder.encode('after.txt'));
    const initial = await makeCommit({ 'code.txt': 'base\n', 'run.sh': 'echo before\n', 'removed.txt': 'remove\n' }, undefined, 'Initial', 'Tester', 1700000000000, {
        'data.bin': { mode: '100644', oid: binary.oid },
        link: { mode: '120000', oid: link.oid },
        module: { mode: '160000', oid: 'a'.repeat(40) },
        'removed.bin': { mode: '100644', oid: binary.oid },
    });
    const put = objects => { for (const o of objects) bucket.data.set(git.key(o.oid), deflateSync(o.raw)); };
    put([...initial.objects, binary, nextBinary, link, nextLink]);
    const ours = await git.save({ ...await git.files(initial.oid), 'code.txt': 'journey edit\n' }, initial.oid, 'Journey work', 'Agent');
    const remote = await makeCommit({ 'code.txt': 'base\n', 'run.sh': 'echo remote\n' }, initial.oid, 'External changes', 'Remote', 1700000001000, {
        'run.sh': { mode: '100755', oid: initial.entries['run.sh'].oid },
        'data.bin': { mode: '100644', oid: nextBinary.oid },
        link: { mode: '120000', oid: nextLink.oid },
        module: { mode: '160000', oid: 'b'.repeat(40) },
    });
    put(remote.objects);
    const merged = mergeFiles(await git.files(initial.oid), await git.files(ours.oid), await git.files(remote.oid));
    const result = await git.save(merged, ours.oid, 'Reconcile', 'Agent', remote.oid);
    const entries = await git.entries(result.oid);
    assert.equal((await git.files(result.oid))['code.txt'], 'journey edit\n');
    assert.equal((await git.files(result.oid))['run.sh'], 'echo remote\n');
    for (const path of ['data.bin', 'link', 'module', 'run.sh']) assert.deepEqual(entries[path], remote.entries[path]);
    assert.equal(entries['removed.bin'], undefined);
    assert.equal(entries['removed.txt'], undefined);
    assert.match(new TextDecoder().decode((await git.read(result.oid)).body), new RegExp(`parent ${ours.oid}`));
    assert.deepEqual((await git.entries(ours.oid))['data.bin'], initial.entries['data.bin']);
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

test('cold source browsing reads only the requested directory and blob in a large import', async () => {
    const bucket = new MemoryBucket(), git = new GitStore(bucket, 'browse');
    const files = Object.fromEntries(Array.from({ length: 871 }, (_, i) => [`dir-${i % 198}/file-${i}.txt`, `File ${i}\n`]));
    files['README.md'] = '';
    const commit = await makeCommit(files, undefined, 'Import', 'Test');
    for (const obj of commit.objects) bucket.data.set(git.key(obj.oid), deflateSync(obj.raw));
    const reads = [], get = bucket.get.bind(bucket);
    bucket.get = async key => { reads.push(key); return get(key); };
    const tree = await git.sourceTree(commit.oid);
    assert.equal(tree.length, 199);
    assert.equal(reads.length, 2, 'one commit and root tree, independent of repository size');
    assert.equal(bucket.writes.length, 0, 'browsing does not build a snapshot or tree index');
    reads.length = 0;
    assert.deepEqual(await git.sourceFile(commit.oid, 'README.md'), { kind: 'text', content: '' });
    assert.equal(reads.length, 3);
    reads.length = 0;
    assert.deepEqual(await git.sourceFile(commit.oid, 'dir-0/file-0.txt'), { kind: 'text', content: 'File 0\n' });
    assert.equal(reads.length, 4);
    reads.length = 0;
    assert((await git.sourceTree(commit.oid, 'dir-0')).length > 0);
    assert.equal(reads.length, 3);
    for (const path of ['../README.md', '/README.md', '.git/config', 'dir-0//file-0.txt'])
        await assert.rejects(git.sourceFile(commit.oid, path), error => error.code === 'invalid_path');
    await assert.rejects(git.sourceFile(commit.oid, 'dir-0'), error => error.code === 'not_file');
    await assert.rejects(git.sourceFile(commit.oid, 'missing'), error => error.code === 'path_not_found');
    await assert.rejects(git.sourceTree(commit.oid, 'README.md'), error => error.code === 'not_directory');
});

test('source previews identify binary, invalid UTF-8, large, symlink and submodule entries honestly', async () => {
    const bucket = new MemoryBucket(), git = new GitStore(bucket, 'special'), entries = {};
    for (const [path, body, mode] of [
        ['binary', new Uint8Array([65, 0, 66]), '100644'],
        ['invalid', new Uint8Array([255]), '100644'],
        ['large', new Uint8Array(500001).fill(65), '100644'],
        ['link', new TextEncoder().encode('somewhere'), '120000'],
    ]) {
        const blob = await object('blob', body); bucket.data.set(git.key(blob.oid), deflateSync(blob.raw)); entries[path] = { mode, oid: blob.oid };
    }
    entries.submodule = { mode: '160000', oid: 'a'.repeat(40) };
    const commit = await makeCommit({}, undefined, 'Special', 'Test', Date.now(), entries);
    for (const obj of commit.objects) bucket.data.set(git.key(obj.oid), deflateSync(obj.raw));
    for (const [path, kind] of [['binary', 'binary'], ['invalid', 'binary'], ['large', 'large'], ['link', 'symlink'], ['submodule', 'submodule']])
        assert.deepEqual(await git.sourceFile(commit.oid, path), { kind });
});
