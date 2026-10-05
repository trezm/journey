import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchReview, patchReviewKey } from '../lib/patch-review.ts';

const patch = { id: 'patch-1', before: 'before-hash', after: 'after-hash' };
const key = patchReviewKey('project-a', patch);
const memoryStorage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('review storage keys separate repositories and every immutable patch revision', () => {
    const keys = [key, patchReviewKey('project-b', patch), patchReviewKey('project-a', { ...patch, id: 'patch-2' }), patchReviewKey('project-a', { ...patch, before: 'other-before' }), patchReviewKey('project-a', { ...patch, after: 'other-after' })];
    assert.equal(new Set(keys).size, keys.length);
    assert.notEqual(patchReviewKey('a:b', { ...patch, id: 'c' }), patchReviewKey('a', { ...patch, id: 'b:c' }));
});

test('viewed paths persist independently, notify subscribers, and have stable snapshots', () => {
    const storage = memoryStorage(), review = new PatchReview(key, () => storage);
    let changes = 0;
    const unsubscribe = review.subscribe(() => changes++);
    assert.equal(review.snapshot(), review.snapshot());
    review.setViewed('src/one.ts', true);
    review.setViewed('src/two.ts', true);
    review.setViewed('src/one.ts', true);
    assert.equal(changes, 2);
    assert.deepEqual(new PatchReview(key, () => storage).snapshot(), ['src/one.ts', 'src/two.ts']);
    review.setViewed('src/one.ts', false);
    assert.deepEqual(new PatchReview(key, () => storage).snapshot(), ['src/two.ts']);
    assert.deepEqual(new PatchReview('another-patch', () => storage).snapshot(), []);
    unsubscribe();
    review.setViewed('src/two.ts', false);
    assert.equal(changes, 3);
    assert.deepEqual(review.snapshot(), []);
});

test('server rendering does not touch storage and malformed stored values are ignored', () => {
    let reads = 0;
    const review = new PatchReview(key, () => { reads++; throw new Error('browser unavailable'); });
    assert.deepEqual(review.serverSnapshot(), []);
    assert.equal(reads, 0);
    for (const value of ['invalid json', '{}', '[1]', 'null', '["valid",false]']) {
        assert.deepEqual(new PatchReview(key, () => ({ getItem: () => value })).snapshot(), []);
    }
    assert.deepEqual(new PatchReview(key, () => ({ getItem: () => '["src/a.ts","src/a.ts"]' })).snapshot(), ['src/a.ts']);
});

test('blocked or full browser storage still supports marking and unmarking during review', () => {
    for (const storage of [() => { throw new Error('blocked'); }, () => ({ getItem: () => '[]', setItem: () => { throw new Error('full'); } })]) {
        const review = new PatchReview(key, storage);
        let changes = 0;
        review.subscribe(() => changes++);
        review.setViewed('src/a.ts', true);
        assert.deepEqual(review.snapshot(), ['src/a.ts']);
        review.setViewed('src/a.ts', false);
        assert.deepEqual(review.snapshot(), []);
        assert.equal(changes, 2);
    }
});
