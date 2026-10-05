import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { acceptedObjects, acceptedRevision, canManageRepository, readerState, repositorySummary, visibility } from '../lib/avc/repository-visibility.ts';
import { GitStore } from '../lib/avc/git.ts';
class MemoryBucket {
    data = new Map();
    async put(key, value) { this.data.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)); }
    async get(key) { const bytes = this.data.get(key); return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => new TextDecoder().decode(bytes) } : null; }
}
test('public reader projection allowlists canonical history and strips every private state surface', () => {
    const s = { id: 'repo', name: 'Repo', head: 'accepted', revisions: { initial: { actor: 'private@example.com', message: 'Initial', at: 1 }, accepted: { parent: 'initial', actor: 'another@example.com', message: 'Accepted', at: 2 }, draft: { actor: 'private@example.com', message: 'Private draft', at: 3 } }, journeys: [{ title: 'Secret plan', head: 'draft', reviews: ['secret'] }], leases: [{ token: 'secret token' }], waiting: ['secret'], events: [{ output: 'secret recording' }], receipts: { secret: true }, sync: { credentialKey: 'secret credential', backupRefs: { secret: 'draft' } }, imported: { refs: { secret: 'draft' } }, importSession: { secret: true }, unknownFutureField: 'secret', sequence: 20, integrationCursor: 18, generation: 11, requireApproval: false };
    const projected = readerState(s), serialized = JSON.stringify(projected);
    assert.deepEqual(Object.keys(projected.revisions), ['accepted', 'initial']);
    for (const secret of ['secret', 'Secret', 'Private draft', '@example.com', 'sync', 'imported', 'unknownFutureField']) assert(!serialized.includes(secret), secret);
    assert.deepEqual(projected.journeys, []); assert.deepEqual(projected.events, []); assert.equal(s.journeys.length, 1);
});
test('personal ownership and scoped agents alone confer management permission', () => {
    const repo = { id: 'repo', owner: 'owner', name: 'Repo', username: 'alice', visibility: 'public' };
    assert(canManageRepository({ id: 'owner', agent: false }, repo));
    assert(canManageRepository({ id: 'agent', agent: true, project: 'repo' }, repo));
    for (const user of [null, { id: 'other', agent: false }, { id: 'owner', agent: true, project: 'another' }]) assert(!canManageRepository(user, repo));
    assert.deepEqual(repositorySummary(repo, null), { id: 'repo', name: 'Repo', visibility: 'public', owner: { username: 'alice' }, permissions: { read: true, write: false } });
    assert.equal(visibility('private'), 'private'); assert.equal(visibility('public'), 'public');
    for (const value of ['PUBLIC', undefined, {}, 'organization']) assert.throws(() => visibility(value), e => e.code === 'invalid_visibility');
});
test('accepted Git reachability allows canonical commits and trees but excludes unpublished or imported side branches', async () => {
    const git = new GitStore(new MemoryBucket(), 'repo');
    const initial = await git.save({ 'README.md': 'accepted' }, undefined, 'Initial', 'Owner');
    const draft = await git.save({ 'private.txt': 'secret' }, initial.oid, 'Draft', 'Worker');
    const accepted = await git.save({ 'README.md': 'accepted later' }, initial.oid, 'Accepted', 'Owner');
    const draftEntries = await git.entries(draft.oid), publicEntries = await git.entries(accepted.oid);
    const allowed = await acceptedObjects(git, accepted.oid);
    assert(allowed.has(accepted.oid)); assert(allowed.has(initial.oid)); assert(allowed.has(publicEntries['README.md'].oid));
    assert(!allowed.has(draft.oid)); assert(!allowed.has(draftEntries['private.txt'].oid));
    assert(await acceptedRevision(git, accepted.oid, initial.oid)); assert(await acceptedRevision(git, accepted.oid, accepted.oid));
    assert(!await acceptedRevision(git, accepted.oid, draft.oid)); assert(!await acceptedRevision(git, accepted.oid, publicEntries['README.md'].oid));
    assert(!await acceptedRevision(git, accepted.oid, '../secret'));
});


test('visibility migration keeps existing repositories private and rejects invalid visibility', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY, owner TEXT); INSERT INTO projects VALUES('existing','owner');");
        db.exec(readFileSync(new URL('../drizzle/0004_repository_visibility.sql', import.meta.url), 'utf8'));
        assert.equal(db.prepare("SELECT visibility FROM projects WHERE id='existing'").get().visibility, 'private');
        db.exec("INSERT INTO projects(id,owner) VALUES('new','owner')");
        assert.equal(db.prepare("SELECT visibility FROM projects WHERE id='new'").get().visibility, 'private');
        assert.throws(() => db.exec("UPDATE projects SET visibility='organization'"), /CHECK/);
        db.exec("UPDATE projects SET visibility='public' WHERE id='existing'");
        assert.equal(db.prepare("SELECT visibility FROM projects WHERE id='existing'").get().visibility, 'public');
    } finally { db.close(); }
});
