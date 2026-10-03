import assert from 'node:assert/strict';

// This mutating test creates disposable local accounts and repositories only.
const root = process.env.AVC_TEST_URL ?? 'http://127.0.0.1:4173';
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(root).hostname), 'Use a disposable loopback preview.');
let cookie = '';
async function request(path, body, credential, expected = 200, code) {
    const response = await fetch(root + path, {
        method: body ? 'POST' : 'GET',
        headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    if (code) assert.equal(data.code, code);
    return data.result ?? data;
}
await request('/api/auth', { action: 'register', email: `owner-integration-${crypto.randomUUID()}@example.com`, password: 'local-owner-integration-2026' });
const ownerCookie = cookie;
const { project } = await request('/api/avc', { action: 'create_project', name: 'Owner integration regression', files: { 'file.txt': 'a\nb\nc\nd\ne\nf' } });
const worker = await request('/api/avc', { action: 'create_agent', project, name: 'Published worker' });
const other = await request('/api/avc', { action: 'create_agent', project, name: 'Other worker' });
const act = (action, body = {}, credential = worker.token, expected = 200, code) => request('/api/avc', { action, project, requestId: crypto.randomUUID(), ...body }, credential, expected, code);
const state = async () => (await request(`/api/avc?project=${project}`)).state;

const initial = await state();
const { journey } = await act('create_journey', { title: 'Owner accepts approved worker code without editing tokens' });
const { changeset } = await act('create_changeset', { journey, description: 'Insert a disjoint prefix' });
const grant = await act('acquire', { journey, changeset, revision: initial.head, scopes: [{ path: 'file.txt', start: 1, end: 1 }] });
assert.equal(grant.queued, false);
const tokens = grant.locks.map(l => l.token);
const patched = await act('patch', { journey, changeset, revision: initial.head, tokens, description: 'Immutable published prefix', edits: [{ path: 'file.txt', content: 'prefix\na\nb\nc\nd\ne\nf' }] });
await act('declare_breaking', { journey, changes: [] });
await act('submit', { journey, revision: patched.revision });
await act('review', { journey, revision: patched.revision, kind: 'approve', body: 'Approve this exact published revision' }, null);

const { journey: protectedJourney } = await act('create_journey', { title: 'Keep other worker disjoint reservation' }, other.token);
const { changeset: protectedStep } = await act('create_changeset', { journey: protectedJourney, description: 'Reserve middle lines' }, other.token);
const protectedGrant = await act('acquire', { journey: protectedJourney, changeset: protectedStep, revision: initial.head, scopes: [{ path: 'file.txt', start: 3, end: 4 }] }, other.token);
assert.equal(protectedGrant.queued, false);
const payload = { action: 'integrate', project, requestId: crypto.randomUUID(), journey, revision: patched.revision, head: initial.head, cursor: initial.integrationCursor };
await request('/api/avc', { ...payload, owner: true, agent: false, user: { agent: false } }, worker.token, 409, 'invalid_lease');
await request('/api/avc', { ...payload, tokens }, other.token, 403, 'forbidden');
await request('/api/avc', { ...payload, requestId: crypto.randomUUID(), head: 'stale' }, null, 409, 'stale_integration');
await request('/api/avc', { ...payload, requestId: crypto.randomUUID(), revision: 'stale' }, null, 409, 'stale_integration');
await request('/api/avc', { ...payload, requestId: crypto.randomUUID(), cursor: initial.integrationCursor + 1 }, null, 409, 'stale_integration');
const accepted = await request('/api/avc', payload); // Owner sends no editing tokens.
const after = await state();
assert.equal(after.head, accepted.revision);
assert.equal(after.journeys.find(j => j.id === journey).status, 'integrated');
assert.equal(after.events.filter(e => e.type === 'journey.integrated').length, 1);
assert.equal(after.leases.length, 1);
assert.equal(after.leases[0].journey, protectedJourney);
assert.equal(after.leases[0].canonicalStart, 3);
assert.equal(after.leases[0].canonicalEnd, 5);
assert.deepEqual(await request('/api/avc', payload), accepted);
assert.equal((await state()).sequence, after.sequence);
await request('/api/avc', { ...payload, cursor: payload.cursor + 1 }, null, 409, 'idempotency_conflict');
await act('abandon', { journey: protectedJourney }, other.token);

// An unrelated signed-in account cannot use the owner's tokenless integration authority.
cookie = '';
await request('/api/auth', { action: 'register', email: `stranger-integration-${crypto.randomUUID()}@example.com`, password: 'local-stranger-integration-2026' });
await request('/api/avc', { ...payload, requestId: crypto.randomUUID() }, null, 403, 'forbidden');
cookie = ownerCookie;

// Exact approval and resolved review requirements still gate owner integration.
const { journey: blocked } = await act('create_journey', { title: 'Owner cannot bypass review' });
const { changeset: blockedStep } = await act('create_changeset', { journey: blocked, description: 'Create empty text file' });
const current = await state();
const whole = await act('acquire', { journey: blocked, changeset: blockedStep, revision: current.head, scopes: [{ path: 'empty.txt', start: 1, end: 1, whole: true }] });
const blockedPatch = await act('patch', { journey: blocked, changeset: blockedStep, revision: current.head, tokens: whole.locks.map(l => l.token), description: 'Publish empty text file', edits: [{ path: 'empty.txt', content: '' }] });
await act('declare_breaking', { journey: blocked, changes: [] });
await act('submit', { journey: blocked, revision: blockedPatch.revision });
const blockedPayload = { journey: blocked, revision: blockedPatch.revision, head: current.head, cursor: current.integrationCursor };
await act('integrate', blockedPayload, null, 409, 'approval_required');
const requested = await act('review', { journey: blocked, revision: blockedPatch.revision, kind: 'request_changes', body: 'Resolve before integrating' }, null);
await act('integrate', blockedPayload, null, 409, 'changes_requested');
await act('resolve_review', { journey: blocked, review: requested.review });
await act('review', { journey: blocked, revision: blockedPatch.revision, kind: 'approve', body: 'Exact empty file candidate accepted' }, null);
await act('integrate', blockedPayload, null);
assert.equal((await state()).journeys.find(j => j.id === blocked).status, 'integrated');
console.log('Owner integration API smoke passed: tokenless owner acceptance, worker and foreign-account isolation, exact review/head/cursor requirements, disjoint lease remapping, empty-file creation, receipt replay and payload-conflict rejection.');
