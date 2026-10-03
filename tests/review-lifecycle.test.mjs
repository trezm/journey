import test from 'node:test';
import assert from 'node:assert/strict';
import { acquire, checkTokens, expire, reconciliationPlan, recordPatch, recordReconciliation, submitForReview, validateSubmission } from '../lib/avc/core.ts';
import { integrationReviewBlocker } from '../lib/avc/review.ts';

function fixture(status = 'review', declared = true) {
    const j = { id: 'worker', title: 'Published work', actor: 'agent', status, base: 'base', head: 'published', reconciledHead: 'base', reconciledCursor: 0, changesets: [{ id: 'step', patches: [{ id: 'patch', before: 'base', after: 'published' }] }], manifest: [{ target: 'API', kind: 'contract', before: 'old', after: 'new', migration: 'Update callers.' }], manifestDeclared: declared, reviews: [{ id: 'approval', kind: 'approve', revision: 'published', resolved: false }], dispositions: {}, created: 0 };
    const s = { id: 'repo', head: 'base', integrationCursor: 0, journeys: [j], leases: [], waiting: [], events: [], sequence: 0, generation: 0, receipts: {}, revisions: {}, requireApproval: true };
    return { s, j };
}
function accepted(s, id, journey = 'other') {
    s.head = `main-${id}`;
    s.integrationCursor = id;
    s.sequence = id;
    s.events.push({ id, type: 'journey.integrated', journey, targets: ['worker'], data: {}, actor: 'owner', at: 0 });
}
const code = expected => error => error.code === expected;

test('expired editing scopes must be reacquired before submission can retain valid grants', () => {
    const { s, j } = fixture('working');
    acquire(s, j, 'step', [{ path: 'file', start: 1, end: 1, whole: true }], j.head, { file: 'published' }, {}, 'agent', 0);
    expire(s, 600001);
    assert.equal(s.leases.length, 0);
    assert.throws(() => submitForReview(s, j, 'published', 'agent', undefined, 600001), code('locks_required'));
    assert.equal(j.status, 'working');
    assert.equal(j.posted, undefined);
    const grant = acquire(s, j, 'step', [{ path: 'file', start: 1, end: 1, whole: true }], j.head, { file: 'published' }, {}, 'agent', 600002);
    const tokens = grant.locks.map(l => l.token);
    assert.deepEqual(submitForReview(s, j, 'published', 'agent', tokens, 600003), { revision: 'published' });
    assert.equal(j.status, 'review');
    assert.equal(j.posted, true);
    assert.equal(s.leases[0].retained, true);
    expire(s, 6000020);
    assert.equal(checkTokens(s, j, tokens, 6000020).length, 1);
});

test('submission still validates exact revision, published patch, manifest, reconciliation and reviews', () => {
    for (const [change, expected] of [
        [({ j }) => { j.head = 'changed'; }, 'stale_revision'],
        [({ j }) => { j.changesets[0].patches = []; }, 'empty_journey'],
        [({ j }) => { j.manifestDeclared = false; }, 'manifest_required'],
        [({ s }) => { accepted(s, 4); }, 'reconciliation_required'],
        [({ j }) => { j.reviews.push({ kind: 'request_changes', resolved: false }); }, 'changes_requested'],
    ]) {
        const f = fixture('working');
        change(f);
        const before = structuredClone(f);
        assert.throws(() => submitForReview(f.s, f.j, 'published', 'agent'), code(expected));
        assert.deepEqual(f, before);
    }
});

test('submitted unaffected work keeps review and its declaration but requires new exact-revision approval', () => {
    const { s, j } = fixture();
    accepted(s, 4);
    accepted(s, 9);
    const manifest = structuredClone(j.manifest);
    const result = recordReconciliation(s, j, 'reconciled', { 4: 'unaffected', 9: 'unaffected' }, 'agent');
    assert.deepEqual(result, { revision: 'reconciled', status: 'review', manifestDeclared: true });
    assert.deepEqual(j.manifest, manifest);
    assert.equal(j.reconciledHead, s.head);
    assert.equal(j.reconciledCursor, 9);
    assert.equal(j.base, s.head);
    assert.equal(j.reviews[0].resolved, true);
    validateSubmission(s, j);
    assert.match(integrationReviewBlocker(j, true), /Awaiting approval/);
    j.reviews.push({ kind: 'approve', revision: 'reconciled', resolved: false });
    assert.equal(integrationReviewBlocker(j, true), null);
});

test('unaffected reconciliation never submits working or undeclared work automatically', () => {
    for (const [status, declared] of [['working', true], ['working', false], ['review', false]]) {
        const { s, j } = fixture(status, declared);
        accepted(s, 3);
        recordReconciliation(s, j, 'new', { 3: 'unaffected' }, 'agent');
        assert.equal(j.status, 'working');
        assert.equal(j.manifestDeclared, declared);
    }
});

test('any adapted disposition requires a new declaration and submission', () => {
    for (const status of ['working', 'review']) {
        const { s, j } = fixture(status);
        accepted(s, 3);
        accepted(s, 7);
        recordReconciliation(s, j, 'adapted', { 3: 'unaffected', 7: 'adapted' }, 'agent');
        assert.equal(j.status, 'working');
        assert.equal(j.manifestDeclared, false);
        assert.equal(j.reviews[0].resolved, true);
        assert.throws(() => submitForReview(s, j, 'adapted', 'agent'), code('manifest_required'));
    }
});

test('unaffected disposition leaves outstanding change requests blocking readiness', () => {
    const { s, j } = fixture();
    j.reviews.push({ kind: 'request_changes', revision: 'published', resolved: false });
    accepted(s, 3);
    recordReconciliation(s, j, 'new', { 3: 'unaffected' }, 'agent');
    assert.equal(j.status, 'review');
    assert.equal(j.reviews[1].resolved, false);
    assert.throws(() => validateSubmission(s, j), code('changes_requested'));
    assert.match(integrationReviewBlocker(j, true), /Resolve outstanding/);
});

test('already-current reconciliation changes no state, event, revision or exact approval', () => {
    for (const status of ['working', 'review']) {
        const { s, j } = fixture(status);
        const before = structuredClone({ s, j });
        assert.deepEqual(recordReconciliation(s, j, 'unnecessary-new-head', undefined, 'agent'), { revision: 'published', status, manifestDeclared: true, unchanged: true });
        assert.deepEqual({ s, j }, before);
    }
});

test('missing and needs-review dispositions fail before changing review state', () => {
    for (const [dispositions, expected] of [[undefined, 'disposition_required'], [{ 3: 'unknown' }, 'disposition_required'], [{ 3: 'needs_review' }, 'needs_review']]) {
        const { s, j } = fixture();
        accepted(s, 3);
        const before = structuredClone({ s, j });
        assert.throws(() => recordReconciliation(s, j, 'new', dispositions, 'agent'), code(expected));
        assert.deepEqual({ s, j }, before);
    }
});

test('only pending other-journey integrations can update dispositions', () => {
    const { s, j } = fixture();
    accepted(s, 1);
    j.reconciledCursor = 1;
    accepted(s, 3, j.id);
    accepted(s, 8);
    const plan = reconciliationPlan(s, j, { 1: 'adapted', 3: 'adapted', 8: 'unaffected', forged: 'adapted' });
    assert.equal(plan.unaffected, true);
    assert.deepEqual(plan.dispositions, { 8: 'unaffected' });
    recordReconciliation(s, j, 'new', { 8: 'unaffected', forged: 'adapted' }, 'agent');
    assert.deepEqual(j.dispositions, { 8: 'unaffected' });
    assert.deepEqual(s.events.at(-1).data.dispositions, { 8: 'unaffected' });
});
