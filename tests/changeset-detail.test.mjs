import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewTarget } from '../lib/avc/review-target.ts';
import { changesetCommentTarget, changesetDiscussion } from '../lib/changeset-detail.ts';

const changeset = { id: 'one', patches: [{ id: 'patch-one' }, { id: 'patch-two' }] };
const journey = (status = 'working') => ({ id: 'journey', status, head: 'current', changesets: [changeset, { id: 'other', patches: [{ id: 'other-patch' }] }] });
const target = (extra = {}) => ({ kind: 'comment', revision: 'current', changeset: 'one', ...extra });
const code = expected => error => error.code === expected;

test('ordinary scoped comments work in every lifecycle state without opening review decision gates', () => {
    for (const status of ['working', 'review', 'integrated', 'abandoned']) {
        assert.doesNotThrow(() => validateReviewTarget(journey(status), target()));
        for (const kind of ['approve', 'request_changes']) {
            if (status === 'review') assert.doesNotThrow(() => validateReviewTarget(journey(status), target({ kind })));
            else assert.throws(() => validateReviewTarget(journey(status), target({ kind })), code('not_in_review'));
        }
    }
});

test('comments reject stale revisions, missing anchors and mismatched patch/changeset pairs', () => {
    for (const status of ['working', 'review', 'integrated', 'abandoned']) {
        assert.throws(() => validateReviewTarget(journey(status), target({ revision: 'old' })), code('stale_review'));
    }
    assert.throws(() => validateReviewTarget(journey(), target({ changeset: 'missing' })), code('changeset_not_found'));
    assert.throws(() => validateReviewTarget(journey(), target({ patch: 'missing' })), code('patch_not_found'));
    assert.throws(() => validateReviewTarget(journey(), target({ patch: 'other-patch' })), code('invalid_review_anchor'));
    assert.throws(() => validateReviewTarget(journey(), target({ changeset: '' })), code('changeset_not_found'));
    assert.doesNotThrow(() => validateReviewTarget(journey(), target({ patch: 'patch-two' })));
    assert.doesNotThrow(() => validateReviewTarget(journey(), { kind: 'comment', revision: 'current', patch: 'patch-one' }));
    assert.doesNotThrow(() => validateReviewTarget(journey(), { kind: 'comment', revision: 'current' }));
    assert.throws(() => validateReviewTarget(journey('review'), target({ kind: 'unknown' })), code('invalid_review'));
});

test('discussion isolates sibling and journey comments while including older patch-only comments', () => {
    const reviews = [
        { id: 'journey-comment', at: 0 },
        { id: 'sibling', changeset: 'other', at: 1 },
        { id: 'selected', changeset: 'one', at: 5 },
        { id: 'legacy-patch', patch: 'patch-two', at: 3 },
        { id: 'sibling-patch', patch: 'other-patch', at: 2 },
        { id: 'contradictory-legacy-anchor', changeset: 'other', patch: 'patch-one', at: 4 },
    ];
    const original = structuredClone(reviews);
    assert.deepEqual(changesetDiscussion(reviews, changeset).map(review => review.id), ['legacy-patch', 'selected']);
    assert.deepEqual(reviews, original);
});

test('composer target captures explicit journey, changeset and current revision without blank padding', () => {
    assert.deepEqual(changesetCommentTarget(journey(), changeset, '  hello\nworld  '), { journey: 'journey', changeset: 'one', revision: 'current', body: 'hello\nworld' });
    assert.equal(changesetCommentTarget({ ...journey(), head: 'new' }, changeset, 'text').revision, 'new');
});

// Run the actual route with an in-memory storage boundary, retaining production
// target validation, state lookup, sync checks, and event emission.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as core from '../lib/avc/core.ts';
import { assertSyncWritable } from '../lib/avc/sync.ts';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiledRoute = ts.transpileModule(readFileSync(new URL('../app/api/avc/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function routeFixture(status = 'working', denied = false) {
    const j = { ...journey(status), reviews: [] };
    const state = { journeys: [j], receipts: {}, events: [], sequence: 0 };
    let authCalls = 0;
    const modules = {
        '@/lib/avc/core': core,
        '@/lib/avc/review-target': { validateReviewTarget },
        '@/lib/avc/sync': { assertSyncWritable },
        '@/lib/avc/storage': { bindings: () => ({ bucket: {} }), mutate: async (_id, fn) => fn(state) },
        '@/lib/avc/auth': {
            sameOrigin: () => {}, digest: async text => text,
            authorize: async (_req, project) => { authCalls++; assert.equal(project, 'repo'); core.insist(!denied, 'forbidden', 'No repository access.', 403); return { id: 'human', agent: false }; },
        },
        '@/lib/avc/git': { GitStore: class {} },
    };
    const exports = {};
    new Function('require', 'exports', compiledRoute)(id => modules[id] ?? {}, exports);
    return { state, j, authCalls: () => authCalls, post: extra => exports.POST(new Request('http://localhost/api/avc', { method: 'POST', body: JSON.stringify({ action: 'review', project: 'repo', requestId: crypto.randomUUID(), journey: j.id, body: 'Scoped comment', ...target(), ...extra }) })) };
}

test('actual review endpoint accepts scoped comments in all states and preserves auth/sync/stale gates', async () => {
    for (const status of ['working', 'review', 'integrated', 'abandoned']) {
        const f = routeFixture(status);
        assert.equal((await f.post({})).status, 200);
        assert.equal(f.authCalls(), 1);
        assert.equal(f.j.reviews[0].changeset, 'one');
        assert.equal(f.j.reviews[0].revision, 'current');
        assert.equal(f.j.reviews[0].actor, 'human');
        assert.equal(f.state.events[0].type, 'review.commented');
        assert.equal((await f.post({ revision: 'old' })).status, 409);
        assert.equal(f.j.reviews.length, 1);
    }
    const denied = routeFixture('working', true);
    assert.equal((await denied.post({})).status, 403);
    assert.equal(denied.j.reviews.length, 0);
    const paused = routeFixture();
    paused.state.sync = { run: { id: 'sync' }, status: 'running' };
    assert.equal((await paused.post({})).status, 409);
    assert.equal(paused.j.reviews.length, 0);
    const f = routeFixture();
    for (const kind of ['approve', 'request_changes']) assert.equal((await f.post({ kind })).status, 409);
    assert.equal((await f.post({ patch: 'other-patch' })).status, 400);
    assert.equal(f.j.reviews.length, 0);
});
