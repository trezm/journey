import test from 'node:test';
import assert from 'node:assert/strict';
import { journeyPage, JOURNEYS_PER_PAGE } from '../lib/journey-list.ts';

const journey = (id, created, values = {}) => ({ id, created, title: `Journey ${id}`, description: '', status: 'working', ...values });
const page = (journeys, options = {}) => journeyPage(journeys, { query: '', status: 'all', page: 1, ...options });

test('newest journeys appear first with deterministic ties without changing repository order', () => {
    const journeys = Object.freeze([journey('old', 1), journey('z', 20), journey('a', 20), journey('new', 30)]);
    assert.deepEqual(page(journeys).items.map(j => j.id), ['new', 'a', 'z', 'old']);
    assert.deepEqual(journeys.map(j => j.id), ['old', 'z', 'a', 'new']);
});

test('trimmed case-insensitive search covers title and description and combines with every status', () => {
    const journeys = [journey('a', 1, { title: 'Fix RENDERING' }), journey('b', 2, { description: 'Rendering docs', status: 'review' }), journey('c', 3, { status: 'integrated' }), journey('d', 4, { status: 'abandoned' })];
    assert.deepEqual(page(journeys, { query: '  rendering  ' }).items.map(j => j.id), ['b', 'a']);
    assert.deepEqual(page(journeys, { query: 'rendering', status: 'review' }).items.map(j => j.id), ['b']);
    for (const status of ['working', 'review', 'integrated', 'abandoned']) {
        const result = page(journeys, { status });
        assert.equal(result.total, 1);
        assert.equal(result.items[0].status, status);
    }
    assert.equal(page(journeys, { query: 'not present' }).total, 0);
    assert.equal(page(journeys, { query: '   ' }).total, 4);
});

test('pagination bounds both ends and covers every journey exactly once', () => {
    const journeys = Array.from({ length: 23 }, (_, i) => journey(String(i).padStart(2, '0'), i));
    const first = page(journeys), middle = page(journeys, { page: 2 }), last = page(journeys, { page: 3 });
    assert.equal(JOURNEYS_PER_PAGE, 10);
    assert.deepEqual([first.start, first.end, first.total, first.page, first.pageCount], [1, 10, 23, 1, 3]);
    assert.deepEqual([middle.start, middle.end, middle.items.length], [11, 20, 10]);
    assert.deepEqual([last.start, last.end, last.items.length], [21, 23, 3]);
    assert.equal(new Set([...first.items, ...middle.items, ...last.items].map(j => j.id)).size, journeys.length);
    assert.equal(page(journeys, { page: 999 }).page, 3);
    assert.equal(page(journeys, { page: -1 }).page, 1);
    assert.equal(page(journeys, { page: NaN }).page, 1);
});

test('an empty search and live removal cannot strand pagination on a missing page', () => {
    const empty = page([], { page: 4 });
    assert.deepEqual([empty.page, empty.pageCount, empty.start, empty.end, empty.total], [1, 1, 0, 0, 0]);
    const reduced = page([journey('remaining', 1)], { page: 4 });
    assert.deepEqual([reduced.page, reduced.pageCount, reduced.start, reduced.end], [1, 1, 1, 1]);
});
