import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLiveFiles, lockGraph } from '../lib/live-map.ts';

const file = (path, overrides = {}) => ({ path, lineCount: 1, exists: true, regions: [], heldLocks: [], conflictCount: 0, lockCount: 0, waitingCount: 0, updatedAt: 0, ...overrides });
const lock = (id, changeset = 'active', conflicts = []) => ({ id, journey: `journey-${changeset}`, changeset, conflictingRequestIds: conflicts });
const change = (id, status = 'working', overrides = {}) => ({ id, journey: `journey-${id}`, title: id, description: id, status, paths: [], lockCount: 0, waitingCount: 0, patchCount: 0, ...overrides });

test('ranking follows conflicts, then held locks, then activity descending with deterministic ties', () => {
    const files = [file('unlocked', { updatedAt: 900 }), file('b', { lockCount: 2, updatedAt: 100 }), file('a', { lockCount: 2, updatedAt: 100 }), file('recent', { lockCount: 2, updatedAt: 200 }), file('many', { lockCount: 5 }), file('conflict', { conflictCount: 1, lockCount: 1 }), file('top', { conflictCount: 2, lockCount: 2 })];
    assert.deepEqual(files.sort(compareLiveFiles).map(file => file.path), ['top', 'conflict', 'many', 'recent', 'a', 'b', 'unlocked']);
});

test('graph connects held ownership only and aggregates multiple locks without history or waiting edges', () => {
    const files = [file('locked', { heldLocks: [lock('l1'), lock('l2', 'active', ['w1']), lock('l3', 'review')], lockCount: 3 }), file('historic'), file('waiting-only', { waitingCount: 1, regions: [{ changesetIds: ['waiting'] }] })];
    const changesets = [change('active', 'working', { paths: ['locked', 'historic'] }), change('review', 'review'), change('waiting', 'working', { paths: ['locked', 'waiting-only'] }), change('old', 'integrated', { paths: ['locked'] })];
    const result = lockGraph(files, changesets);
    assert.deepEqual(result.files.map(file => file.path), ['locked']);
    assert.deepEqual(result.changesets.map(change => change.id), ['active', 'review']);
    assert.deepEqual(result.edges, [{ file: 'locked', changeset: 'active', lockCount: 2, conflictCount: 1 }, { file: 'locked', changeset: 'review', lockCount: 1, conflictCount: 0 }]);
});

test('graph drops completed or missing owners and does not drop connected owners when files are paged', () => {
    const files = [file('old', { heldLocks: [lock('l1', 'old')] }), file('missing', { heldLocks: [lock('l2', 'missing')] }), file('visible', { heldLocks: [lock('l3', 'review'), lock('l4', 'active')] })];
    const result = lockGraph(files, [change('old', 'integrated'), change('review', 'review'), change('active')]);
    assert.deepEqual(result.files.map(file => file.path), ['visible']);
    assert.equal(result.changesets.length, 2); assert.equal(result.edges.length, 2);
    assert.deepEqual(lockGraph([file('bad', { heldLocks: [{ ...lock('l5'), journey: 'wrong' }] })], [change('active')]).files, []);
});
