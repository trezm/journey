import test from 'node:test';
import assert from 'node:assert/strict';
import { publicState } from '../lib/avc/core.ts';
import { syncView } from '../lib/avc/sync-view.ts';

const state = () => ({
    journeys: [], leases: [], receipts: {},
    sync: {
        remote: 'https://github.com/team/repo', branch: 'main', enabled: true, status: 'running', updatedAt: 1,
        cloud: { credential: 'private-credential', generation: 'private-generation', lease: { token: 'private-token', until: 100 }, nextAttemptAt: 42,
            work: { phase: 'import', seen: ['object-a', 'object-b'], todo: [{ hash: 'object-c' }], original: 'original', remote: 'remote' } },
    },
});

test('workspace exposes the same bounded progress as sync settings without cloud internals', () => {
    const stored = state();
    const settings = syncView(stored.sync), workspace = publicState(stored, 'owner').sync;
    assert.deepEqual(workspace, settings);
    assert.deepEqual(workspace.progress, { phase: 'import', objects: 2, pending: 1 });
    assert.equal(workspace.nextAttemptAt, 42);
    assert.equal(workspace.hosted, true);
    assert.equal(workspace.cloud, undefined);
    assert.doesNotMatch(JSON.stringify(workspace), /private-|object-a|object-b|object-c|original/);
    assert.equal(stored.sync.cloud.work.seen.length, 2, 'serialization does not change persisted work');
});

test('phase transitions reset counts and completion removes progress', () => {
    const stored = state();
    stored.sync.cloud.work = { ...stored.sync.cloud.work, phase: 'remote-ancestry', seen: [], todo: [] };
    assert.deepEqual(syncView(stored.sync).progress, { phase: 'remote-ancestry', objects: 0, pending: 0 });
    delete stored.sync.cloud.work;
    stored.sync.status = 'idle';
    assert.equal(publicState(stored, 'owner').sync.progress, null);
    delete stored.sync;
    assert.equal(publicState(stored, 'owner').sync, undefined);
});

test('legacy bridge state remains usable without hosted counters', () => {
    const stored = state(); delete stored.sync.cloud;
    assert.deepEqual(syncView(stored.sync), stored.sync);
    assert.equal(syncView(stored.sync).progress, undefined);
});
