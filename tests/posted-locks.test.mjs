import test from 'node:test';
import assert from 'node:assert/strict';
import { acquire, checkTokens, expire, finalizeIntegration, leaseActive, normalizePostedLocks, recordPatch, recordReconciliation, retainedExpiry, submitForReview, validateIntegrationAuthority } from '../lib/avc/core.ts';
import { integrationFiles } from '../lib/avc/integration.ts';
import { decodeState, encodeState } from '../lib/avc/state-codec.ts';

const now = 1000;
const before = { 'file.txt': 'a\nb\nc\nd\ne' }, candidate = { 'file.txt': 'a\nB\nc\nd\ne' };
function fixture(status = 'working') {
    const j = { id: 'first', title: 'Published changes', actor: 'agent', status, base: 'base', head: 'candidate', reconciledHead: 'base', reconciledCursor: 0, changesets: [{ id: 'step', patches: [{ id: 'published' }] }], manifest: [], manifestDeclared: true, reviews: [], dispositions: {}, created: 0 };
    const s = { id: 'repo', name: 'Repo', head: 'base', integrationCursor: 0, journeys: [j], leases: [], waiting: [], events: [], sequence: 0, generation: 0, receipts: {}, revisions: {}, requireApproval: true };
    return { s, j };
}
function grant(s, j, scope = { path: 'file.txt', start: 2, end: 2 }, time = now) {
    const result = acquire(s, j, 'step', [scope], 'base', before, before, j.actor, time, candidate);
    assert.equal(result.queued, false);
    return result.locks;
}
const tokens = locks => locks.map(l => l.token);
const code = expected => error => error.code === expected;

test('posting retains actual scope identity and survives elapsed numeric deadlines without renewal', () => {
    const { s, j } = fixture();
    const locks = grant(s, j), identity = structuredClone(locks[0]);
    integrationFiles(s, j, before, before, candidate, tokens(locks), now);
    submitForReview(s, j, j.head, j.actor, undefined, now);
    assert.equal(j.posted, true);
    assert.equal(j.status, 'review');
    assert.equal(locks[0].retained, true);
    assert.equal(locks[0].expires, retainedExpiry);
    assert.equal(locks[0].id, identity.id);
    assert.equal(locks[0].token, identity.token);
    assert.equal(locks[0].generation, identity.generation);
    assert.deepEqual([locks[0].canonicalStart, locks[0].canonicalEnd], [identity.canonicalStart, identity.canonicalEnd]);
    locks[0].expires = now - 1;
    expire(s, retainedExpiry + 1000);
    assert.equal(s.leases.length, 1);
    assert.equal(checkTokens(s, j, tokens(locks), retainedExpiry + 1000).length, 1);
    assert.equal(s.events.some(e => e.type === 'lock.expired'), false);
});

test('retained overlapping scopes stay exclusive while unrelated unposted scopes expire', () => {
    const { s, j } = fixture();
    grant(s, j);
    submitForReview(s, j, j.head, j.actor, undefined, now);
    const second = { ...structuredClone(j), id: 'second', actor: 'other', status: 'working', posted: undefined };
    s.journeys.push(second);
    const queued = acquire(s, second, 'step', [{ path: 'file.txt', start: 2, end: 2 }], 'base', before, before, second.actor, retainedExpiry + 1000);
    assert.equal(queued.queued, true);
    assert.equal(s.leases.length, 1);
    grant(s, second, { path: 'file.txt', start: 5, end: 5 }, now);
    expire(s, now + 600001);
    assert.equal(s.leases.length, 1);
    assert.equal(s.leases[0].journey, j.id);
    assert(s.events.some(e => e.type === 'lock.expired' && e.journey === second.id));
});

test('patching posted work preserves retained scopes even when review becomes in progress', () => {
    const { s, j } = fixture();
    const locks = grant(s, j, { path: 'file.txt', start: 1, end: 1, whole: true });
    submitForReview(s, j, j.head, j.actor, undefined, now);
    recordPatch(s, j, 'step', { 'file.txt': 'a\nupdated\nc\nd\ne' }, candidate, 'updated', 'Respond to review', j.actor, tokens(locks), retainedExpiry + 1000);
    assert.equal(j.status, 'working');
    assert.equal(j.manifestDeclared, false);
    assert.equal(j.posted, true);
    assert.equal(s.leases[0].retained, true);
    assert.equal(s.leases[0].token, locks[0].token);
    expire(s, retainedExpiry + 2000);
    assert.equal(s.leases.length, 1);
});

test('unaffected and adapted reconciliation retain holds and still invalidate old exact approval', () => {
    for (const disposition of ['unaffected', 'adapted']) {
        const { s, j } = fixture();
        const locks = grant(s, j);
        submitForReview(s, j, j.head, j.actor, undefined, now);
        j.reviews.push({ kind: 'approve', revision: j.head, actor: 'owner', resolved: false });
        const identities = tokens(locks);
        s.head = 'accepted'; s.integrationCursor = 10; s.sequence = 10;
        s.events.push({ id: 10, type: 'journey.integrated', journey: 'second', targets: [j.id], data: {}, actor: 'owner', at: now });
        recordReconciliation(s, j, 'reconciled', { 10: disposition }, j.actor);
        assert.equal(j.status, disposition === 'unaffected' ? 'review' : 'working');
        assert.equal(j.posted, true);
        assert.equal(j.reviews[0].resolved, true);
        assert.deepEqual(tokens(s.leases), identities);
        expire(s, retainedExpiry + 1000);
        assert.equal(checkTokens(s, j, identities, retainedExpiry + 1000).length, 1);
        assert.throws(() => validateIntegrationAuthority(s, j, { id: 'owner', agent: false }), code('approval_required'));
    }
});

test('new grants after posting stay retained across review invalidation', () => {
    const { s, j } = fixture();
    grant(s, j);
    submitForReview(s, j, j.head, j.actor, undefined, now);
    j.status = 'working'; j.manifestDeclared = false;
    const added = grant(s, j, { path: 'file.txt', start: 5, end: 5, retained: false }, now + 600001);
    assert.equal(added[0].retained, true);
    assert.equal(added[0].expires, retainedExpiry);
    assert.equal(s.events.at(-1).data.locks[0].retained, true);
    expire(s, retainedExpiry + 1000);
    assert.equal(s.leases.length, 2);
});

test('caller-supplied retained flags cannot promote unposted draft grants', () => {
    const { s, j } = fixture();
    const locks = grant(s, j, { path: 'file.txt', start: 2, end: 2, retained: true });
    assert.equal(j.posted, undefined);
    assert.equal(locks[0].retained, undefined);
    assert.equal(locks[0].expires, now + 600000);
    expire(s, now + 600001);
    assert.equal(s.leases.length, 0);
});

test('legacy review and submitted-then-working history retain only still-valid actual grants', () => {
    for (const status of ['review', 'working']) {
        const { s, j } = fixture();
        const locks = grant(s, j);
        j.status = status;
        if (status === 'working') s.events.push({ id: ++s.sequence, type: 'review.requested', journey: j.id, targets: [j.id], data: {}, actor: j.actor, at: now });
        assert.equal(normalizePostedLocks(s, now + 1), true);
        assert.equal(j.posted, true);
        assert.equal(locks[0].retained, true);
        assert.equal(locks[0].expires, retainedExpiry);
        assert.equal(normalizePostedLocks(s, now + 2), false);
        expire(s, now + 900000);
        assert.equal(s.leases.length, 1);
    }
});

test('legacy already-expired grants cannot be resurrected by posted history normalization', () => {
    const { s, j } = fixture();
    const old = grant(s, j);
    j.status = 'review';
    old[0].expires = now;
    expire(s, now + 1);
    assert.equal(j.posted, true);
    assert.equal(s.leases.length, 0);
    assert.throws(() => checkTokens(s, j, tokens(old), now + 1), code('locks_required'));
    assert.throws(() => submitForReview(s, j, j.head, j.actor, tokens(old), now + 1), code('locks_required'));
    const fresh = grant(s, j, { path: 'file.txt', start: 2, end: 2 }, now + 2);
    assert.notEqual(fresh[0].token, old[0].token);
    assert.equal(fresh[0].retained, true);
    assert.throws(() => checkTokens(s, j, tokens(old), now + 2), code('invalid_lease'));
});

test('unsuccessful submission never retains grants or records a posted marker', () => {
    for (const failed of ['revision', 'manifest', 'tokens']) {
        const { s, j } = fixture();
        const locks = grant(s, j);
        if (failed === 'manifest') j.manifestDeclared = false;
        const snapshot = structuredClone(s);
        assert.throws(() => submitForReview(s, j, failed === 'revision' ? 'old' : j.head, j.actor, failed === 'tokens' ? [] : tokens(locks), now), code({ revision: 'stale_revision', manifest: 'manifest_required', tokens: 'invalid_lease' }[failed]));
        assert.deepEqual(s, snapshot);
        assert.equal(locks[0].retained, undefined);
    }
});

test('complete candidate coverage is required even when some current scopes are held', () => {
    const { s, j } = fixture();
    const locks = grant(s, j);
    const changed = { 'file.txt': 'a\nB\nc\nd\nE' };
    assert.throws(() => integrationFiles(s, j, before, before, changed, tokens(locks), now), code('lock_coverage'));
    assert.equal(j.posted, undefined);
    assert.equal(locks[0].retained, undefined);
    const more = grant(s, j, { path: 'file.txt', start: 5, end: 5 });
    const all = tokens([...locks, ...more]);
    assert.deepEqual({ ...integrationFiles(s, j, before, before, changed, all, now) }, changed);
});

test('all-principal integration rejects missing tokens even when retained deadlines are elapsed', () => {
    const { s, j } = fixture();
    const locks = grant(s, j);
    submitForReview(s, j, j.head, j.actor, undefined, now);
    locks[0].expires = now - 1;
    assert.throws(() => integrationFiles(s, j, before, before, candidate, [], now + 900000), code('invalid_lease'));
    assert.deepEqual({ ...integrationFiles(s, j, before, before, candidate, tokens(locks), now + 900000) }, candidate);
    assert.throws(() => checkTokens(s, j, locks[0].token, now + 900000), code('invalid_lease'));
});

test('other retained reservations still block final overlapping integration after elapsed deadlines', () => {
    const { s, j } = fixture();
    const own = grant(s, j);
    submitForReview(s, j, j.head, j.actor, undefined, now);
    s.leases.push({ ...own[0], id: 'other-lock', token: 'other-token', journey: 'second', retained: true, expires: now - 1 });
    assert.throws(() => integrationFiles(s, j, before, before, candidate, tokens(own), now + 900000), code('integration_lock_conflict'));
});

test('successful integration releases only its Journey retained scopes and remaps disjoint holds', () => {
    const { s, j } = fixture();
    grant(s, j);
    submitForReview(s, j, j.head, j.actor, undefined, now);
    const second = { ...structuredClone(j), id: 'second', actor: 'other', status: 'working', posted: true };
    s.journeys.push(second);
    const other = grant(s, second, { path: 'file.txt', start: 5, end: 5 });
    const identity = structuredClone(other[0]);
    const third = { ...structuredClone(second), id: 'third', posted: undefined };
    s.journeys.push(third);
    assert.equal(acquire(s, third, 'step', [{ path: 'file.txt', start: 2, end: 2 }], 'base', before, before, third.actor, now).queued, true);
    finalizeIntegration(s, j, 'accepted', 'owner', before, { 'file.txt': 'prefix\na\nb\nc\nd\ne' });
    assert.equal(s.leases.length, 1);
    assert.equal(s.leases[0].journey, second.id);
    assert.equal(s.leases[0].retained, true);
    assert.equal(s.leases[0].token, identity.token);
    assert.equal(s.leases[0].canonicalStart, identity.canonicalStart + 1);
    assert.equal(s.leases[0].canonicalEnd, identity.canonicalEnd + 1);
    assert(s.events.some(e => e.type === 'lock.available'));
});

test('old and retained metadata roundtrip without changing numeric compatibility or token identity', () => {
    const { s, j } = fixture();
    const old = structuredClone(s);
    assert.deepEqual(decodeState(encodeState(old)), old);
    const locks = grant(s, j);
    submitForReview(s, j, j.head, j.actor, undefined, now);
    const decoded = decodeState(encodeState(s));
    assert.equal(decoded.journeys[0].posted, true);
    assert.equal(decoded.leases[0].retained, true);
    assert.equal(typeof decoded.leases[0].expires, 'number');
    assert.equal(decoded.leases[0].token, locks[0].token);
    assert.equal(leaseActive(decoded.leases[0], retainedExpiry + 1000), true);
});
