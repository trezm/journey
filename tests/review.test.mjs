import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationReviewBlocker } from '../lib/avc/review.ts';

const review = (kind, revision = 'current', resolved = false) => ({ kind, revision, resolved });
const journey = (reviews = [], status = 'review') => ({ status, head: 'current', reviews });

test('a submitted revision stays blocked until that exact revision is approved', () => {
    assert.match(integrationReviewBlocker(journey(), true), /Awaiting approval/);
    assert.match(integrationReviewBlocker(journey([review('comment')]), true), /Awaiting approval/);
    assert.equal(integrationReviewBlocker(journey([review('approve')]), true), null);
});

test('old or invalidated approvals cannot enable integration', () => {
    assert.match(integrationReviewBlocker(journey([review('approve', 'previous')]), true), /Awaiting approval/);
    assert.match(integrationReviewBlocker(journey([review('approve', 'current', true)]), true), /Awaiting approval/);
});

test('approval does not bypass submission or allow closed journeys to integrate', () => {
    for (const status of ['working', 'integrated', 'abandoned'])
        assert.match(integrationReviewBlocker(journey([review('approve')], status), true), /Submit this revision/);
});

test('outstanding change requests block approved revisions until resolved', () => {
    assert.match(integrationReviewBlocker(journey([review('approve'), review('request_changes')]), true), /Resolve outstanding/);
    assert.equal(integrationReviewBlocker(journey([review('approve'), review('request_changes', 'current', true)]), true), null);
});

test('optional approval still requires submission and resolved change requests', () => {
    assert.equal(integrationReviewBlocker(journey(), false), null);
    assert.match(integrationReviewBlocker(journey([], 'working'), false), /Submit this revision/);
    assert.match(integrationReviewBlocker(journey([review('request_changes')]), false), /Resolve outstanding/);
});


test('the browser default requires approval and rejects coordinators without current permission', () => {
    assert.match(integrationReviewBlocker(journey()), /Awaiting approval/);
    const approved = journey([{ ...review('approve'), authority: 'coordinator' }]);
    assert.match(integrationReviewBlocker(approved), /Awaiting approval/);
    assert.equal(integrationReviewBlocker(approved, true, true), null);
    assert.match(integrationReviewBlocker(approved, true, false), /Awaiting approval/);
    approved.reviews[0].resolved = true;
    assert.match(integrationReviewBlocker(approved, true, true), /Awaiting approval/);
    assert.equal(integrationReviewBlocker(journey([{ ...review('approve'), authority: 'human' }])), null);
});
