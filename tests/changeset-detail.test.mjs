import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewTarget, reviewReplyTarget } from '../lib/avc/review-target.ts';
import { changesetCommentTarget, changesetDiscussion, patchLineCommentTarget } from '../lib/changeset-detail.ts';

const changeset = { id: 'one', patches: [{ id: 'patch-one', changes: [{ path: 'file.ts', hunks: [] }] }, { id: 'patch-two', changes: [{ path: 'file.ts', hunks: [] }] }] };
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

test('line comments require a valid path, side, line context, and matching changeset patch', () => {
    const anchor = { path: 'file.ts', side: 'before', line: 2, context: 'old value' };
    assert.doesNotThrow(() => validateReviewTarget(journey(), target({ patch: 'patch-one', anchor })));
    assert.throws(() => validateReviewTarget(journey(), target({ anchor })), code('invalid_review_anchor'));
    assert.throws(() => validateReviewTarget(journey(), target({ patch: 'patch-one', anchor: { ...anchor, path: 'missing.ts' } })), code('invalid_line_anchor'));
    assert.throws(() => validateReviewTarget(journey(), target({ patch: 'patch-one', anchor: { ...anchor, line: 0 } })), code('invalid_line_anchor'));
    assert.throws(() => validateReviewTarget(journey(), target({ patch: 'patch-one', anchor: { ...anchor, side: 'middle' } })), code('invalid_line_anchor'));
    assert.throws(() => validateReviewTarget(journey('review'), target({ patch: 'patch-one', kind: 'approve', anchor })), code('invalid_review_anchor'));
});

test('line anchors are checked against the selected immutable patch snapshot', () => {
    const j = journey();
    j.changesets[0].patches[0].changes[0].hunks = core.diff('old line\nshared', 'new line\nshared');
    const anchor = { path: 'file.ts', side: 'before', line: 1, context: 'untrusted client text' };
    const saved = validateReviewTarget(j, target({ patch: 'patch-one', anchor }), { before: { 'file.ts': 'old line\nshared' }, after: { 'file.ts': 'new line\nshared' } });
    assert.deepEqual(saved, { path: 'file.ts', side: 'before', line: 1, context: 'old line' });
    assert.throws(() => validateReviewTarget(j, target({ patch: 'patch-one', anchor: { ...anchor, line: 50 } }), { before: { 'file.ts': 'old line\nshared' }, after: { 'file.ts': 'new line\nshared' } }), code('invalid_line_anchor'));
    assert.throws(() => validateReviewTarget(j, target({ patch: 'patch-one', anchor: { ...anchor, side: 'after' } }), { before: { 'file.ts': 'old line\nshared' }, after: {} }), code('invalid_line_anchor'));
    assert.throws(() => validateReviewTarget(j, target({ patch: 'patch-one', anchor: { ...anchor, side: 'before' } }), { before: {}, after: { 'file.ts': 'new line' } }), code('invalid_line_anchor'));
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
    assert.deepEqual(patchLineCommentTarget(journey(), changeset, changeset.patches[0], { path: 'file.ts', side: 'after', line: 4, context: 'new value' }, '  precise note '), { journey: 'journey', changeset: 'one', revision: 'current', body: 'precise note', patch: 'patch-one', anchor: { path: 'file.ts', side: 'after', line: 4, context: 'new value' } });
});

// Run the actual route with an in-memory storage boundary, retaining production
// target validation, receipt lookup, state lookup, sync checks, and event emission.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as core from '../lib/avc/core.ts';
import { assertSyncWritable } from '../lib/avc/sync.ts';
import { readReceipt } from '../lib/avc/receipt-archive.ts';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiledRoute = ts.transpileModule(readFileSync(new URL('../app/api/avc/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function routeFixture(status = 'working', denied = false) {
    const j = { ...journey(status), reviews: [] };
    Object.assign(j.changesets[0].patches[0], { before: 'before', after: 'after' });
    j.changesets[0].patches[0].changes[0].hunks = core.diff('old line', 'new line');
    const state = { journeys: [j], receipts: {}, events: [], sequence: 0 };
    let authCalls = 0;
    const modules = {
        '@/lib/avc/core': core,
        '@/lib/avc/review-target': { validateReviewTarget, reviewReplyTarget },
        '@/lib/avc/sync': { assertSyncWritable },
        '@/lib/avc/receipt-archive': { readReceipt },
        // These route dependencies are unused by the review action.
        '@/lib/avc/repository-access': {},
        '@/lib/avc/repository-visibility': {},
        '@/lib/avc/integration': {},
        '@/lib/avc/live': {},
        '@/lib/avc/storage': { bindings: () => ({ bucket: {} }), mutate: async (_id, fn) => fn(state) },
        '@/lib/avc/auth': {
            sameOrigin: () => {}, digest: async text => text,
            authorize: async (_req, project) => { authCalls++; assert.equal(project, 'repo'); core.insist(!denied, 'forbidden', 'No repository access.', 403); return { id: 'human', agent: false }; },
        },
        '@/lib/avc/git': { GitStore: class { files = async revision => revision === 'before' ? { 'file.ts': 'old line' } : { 'file.ts': 'new line' }; } },
    };
    const exports = {};
    new Function('require', 'exports', compiledRoute)(id => {
        assert.ok(Object.hasOwn(modules, id), `Review route fixture is missing dependency: ${id}`);
        return modules[id];
    }, exports);
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
    assert.equal((await f.post({ patch: 'patch-one', anchor: { path: 'file.ts', side: 'after', line: 1, context: 'line' } })).status, 200);
    assert.deepEqual(f.j.reviews[0].anchor, { path: 'file.ts', side: 'after', line: 1, context: 'new line' });
    assert.equal((await f.post({ patch: 'patch-one', anchor: { path: 'missing.ts', side: 'after', line: 1, context: 'line' } })).status, 400);
    assert.equal((await f.post({ patch: 'patch-one', anchor: { path: 'file.ts', side: 'after', line: 20, context: 'line' } })).status, 400);
    assert.equal(f.j.reviews.length, 1);
    const f2 = routeFixture();
    for (const kind of ['approve', 'request_changes']) assert.equal((await f2.post({ kind })).status, 409);
    assert.equal((await f2.post({ patch: 'other-patch' })).status, 400);
    assert.equal(f2.j.reviews.length, 0);
});

test('actual review endpoint replays comment retries without duplicating reviews or events', async () => {
    const f = routeFixture();
    const requestId = crypto.randomUUID();
    const first = await f.post({ requestId });
    assert.equal(first.status, 200, await first.clone().text());
    const result = await first.json();
    const retry = await f.post({ requestId });
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.deepEqual(await retry.json(), result);
    assert.equal(f.authCalls(), 2);
    assert.equal(f.j.reviews.length, 1);
    assert.equal(f.state.events.length, 1);

    const conflict = await f.post({ requestId, body: 'Different comment' });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'idempotency_conflict');
    assert.equal(f.j.reviews.length, 1);
    assert.equal(f.state.events.length, 1);
});


test('actual endpoint persists replies, inherits immutable anchors and includes parent in inbox events', async () => {
    const f = routeFixture();
    await f.post({ patch: 'patch-one', anchor: { path: 'file.ts', side: 'after', line: 1, context: 'line' } });
    const parent = f.j.reviews[0];
    parent.revision = 'older';
    const requestId = crypto.randomUUID();
    const reply = { replyTo: parent.id, changeset: undefined, body: 'Fixed with a clearer table.', requestId };
    assert.equal((await f.post(reply)).status, 200);
    assert.equal((await f.post(reply)).status, 200);
    assert.equal(f.j.reviews.length, 2);
    assert.equal(f.j.reviews[1].replyTo, parent.id);
    assert.equal(f.j.reviews[1].revision, 'current');
    assert.equal(f.j.reviews[1].changeset, 'one');
    assert.equal(f.j.reviews[1].patch, 'patch-one');
    assert.deepEqual(f.j.reviews[1].anchor, parent.anchor);
    assert.equal(f.state.events.at(-1).data.replyTo, parent.id);
    assert.equal((await f.post({ replyTo: parent.id, patch: 'patch-two' })).status, 400);
    assert.equal((await f.post({ replyTo: 'another-journey-comment' })).status, 404);
    assert.equal((await f.post({ replyTo: parent.id, revision: 'older' })).status, 409);
    assert.equal(f.j.reviews.length, 2);
});
