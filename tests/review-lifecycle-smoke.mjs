import assert from 'node:assert/strict';

// Run only against a disposable local preview: this creates its own account and repository.
const root = process.env.AVC_TEST_URL ?? 'http://127.0.0.1:4173';
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(root).hostname), 'Use a local preview for this mutating regression test.');
let cookie = '';
async function request(path, body, token, expected = 200, code) {
    const response = await fetch(root + path, {
        method: body ? 'POST' : 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    if (code) assert.equal(data.code, code);
    return data.result ?? data;
}
await request('/api/auth', { action: 'register', username: 'test-' + crypto.randomUUID().slice(0, 24), email: `lifecycle-${crypto.randomUUID()}@example.com`, password: 'local-lifecycle-test-2026' });
const { project } = await request('/api/avc', { action: 'create_project', name: 'Review lifecycle regression' });
const agent = await request('/api/avc', { action: 'create_agent', project, name: 'Lifecycle worker' });
const other = await request('/api/avc', { action: 'create_agent', project, name: 'Other worker' });
const act = (action, body = {}, token = agent.token, expected = 200, code) => request('/api/avc', { action, project, requestId: crypto.randomUUID(), ...body }, token, expected, code);
const state = async () => (await request(`/api/avc?project=${project}`, undefined, agent.token)).state;
const current = async id => (await state()).journeys.find(j => j.id === id);

async function candidate(title, path, submitted = true) {
    const { journey } = await act('create_journey', { title });
    const { changeset } = await act('create_changeset', { journey, description: title });
    const revision = (await current(journey)).head;
    const grants = await act('acquire', { journey, changeset, revision, scopes: [{ path, start: 1, end: 1, whole: true }] });
    assert.equal(grants.queued, false);
    const tokens = grants.locks.map(lock => lock.token);
    const patch = await act('patch', { journey, changeset, revision, tokens, description: title, edits: [{ path, content: title + '\n' }] });
    await act('declare_breaking', { journey, changes: [] });
    if (submitted) await act('submit', { journey, revision: patch.revision }); // No lock tokens supplied.
    return { journey, revision: patch.revision, tokens };
}

const retained = await candidate('Already submitted', 'retained.txt');
const working = await candidate('Still in progress', 'working.txt', false);
const adapted = await candidate('Needs adaptation', 'adapted.txt');
const requested = await candidate('Has change request', 'requested.txt');
await act('review', { ...retained, kind: 'approve', body: 'Approve original exact revision' }, null);
await act('review', { ...adapted, kind: 'approve', body: 'Approve original before adaptation' }, null);
const change = await act('review', { ...requested, kind: 'request_changes', body: 'Please resolve this request' }, null);
await act('submit', { journey: working.journey, revision: working.revision }, other.token, 403, 'forbidden');
await act('submit', { journey: working.journey, revision: 'stale' }, agent.token, 409, 'stale_revision');

const accepted = await candidate('Independent accepted work', 'accepted.txt');
await act('review', { ...accepted, kind: 'approve', body: 'Ready to accept' }, null);
const beforeIntegration = await state();
const integration = await act('integrate', { ...accepted, head: beforeIntegration.head, cursor: beforeIntegration.integrationCursor });
const canonical = await state();
const reconcile = (entry, disposition, expected = 200, code) => act('reconcile', {
    journey: entry.journey, head: canonical.head, cursor: canonical.integrationCursor,
    ...(disposition ? { dispositions: { [integration.event]: disposition } } : {}),
}, agent.token, expected, code);

await act('submit', { journey: retained.journey, revision: retained.revision }, agent.token, 409, 'reconciliation_required');
await reconcile(retained, undefined, 400, 'disposition_required');
await reconcile(retained, 'needs_review', 409, 'needs_review');
assert.equal((await current(retained.journey)).head, retained.revision);
const retainedResult = await reconcile(retained, 'unaffected');
assert.equal(retainedResult.status, 'review');
assert.equal(retainedResult.manifestDeclared, true);
assert.notEqual(retainedResult.revision, retained.revision);
let journey = await current(retained.journey);
assert.equal(journey.status, 'review');
assert.equal(journey.reviews.find(review => review.kind === 'approve').resolved, true);
await act('review', { ...retained, kind: 'approve', body: 'Stale approval attempt' }, null, 409, 'stale_review');
await act('integrate', { journey: retained.journey, revision: journey.head, head: canonical.head, cursor: canonical.integrationCursor }, agent.token, 409, 'invalid_lease');
await act('integrate', { ...retained, revision: journey.head, head: canonical.head, cursor: canonical.integrationCursor }, agent.token, 409, 'approval_required');
await act('review', { journey: retained.journey, revision: journey.head, kind: 'approve', body: 'Approve reconciled exact revision' }, null);
const beforeNoop = await state();
const noop = await reconcile(retained, undefined);
assert.equal(noop.unchanged, true);
assert.equal(noop.revision, journey.head);
assert.equal((await state()).sequence, beforeNoop.sequence);
journey = await current(retained.journey);
assert.equal(journey.reviews.at(-1).resolved, undefined);

await act('reconcile', { journey: working.journey, head: 'stale', cursor: canonical.integrationCursor, dispositions: { [integration.event]: 'unaffected' } }, agent.token, 409, 'stale_reconciliation');
const workingResult = await reconcile(working, 'unaffected');
assert.equal(workingResult.status, 'working');
assert.equal(workingResult.manifestDeclared, true);
await act('submit', { journey: working.journey, revision: workingResult.revision });

const adaptedResult = await reconcile(adapted, 'adapted');
assert.equal(adaptedResult.status, 'working');
assert.equal(adaptedResult.manifestDeclared, false);
await act('submit', { journey: adapted.journey, revision: adaptedResult.revision }, agent.token, 409, 'manifest_required');
await act('declare_breaking', { journey: adapted.journey, changes: [] });
await act('submit', { journey: adapted.journey, revision: adaptedResult.revision });

const requestedResult = await reconcile(requested, 'unaffected');
assert.equal(requestedResult.status, 'review');
assert.equal((await current(requested.journey)).reviews.find(review => review.id === change.review).resolved, undefined);
await act('submit', { journey: requested.journey, revision: requestedResult.revision }, agent.token, 409, 'changes_requested');
await act('review', { journey: requested.journey, revision: requestedResult.revision, kind: 'approve', body: 'Cannot skip changes' }, null, 409, 'changes_requested');
await act('resolve_review', { journey: requested.journey, review: change.review });
await act('submit', { journey: requested.journey, revision: requestedResult.revision });
console.log('Review lifecycle API regression passed: tokenless submission, unchanged submitted status, preserved declarations, exact-revision approval, idempotent reconciliation, adapted reset, unresolved requests, ownership and worker integration lease checks.');
