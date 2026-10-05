import assert from 'node:assert/strict';

const root = process.env.AVC_TEST_URL ?? 'http://127.0.0.1:4173';
let cookie = '';
async function request(path, body) {
    const response = await fetch(root + path, {
        method: body ? 'POST' : 'GET',
        headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result ?? data;
}
await request('/api/auth', { action: 'register', username: 'test-' + crypto.randomUUID().slice(0, 24), email: `storage-${crypto.randomUUID()}@example.com`, password: 'Storage-test-password-2026' });
const paths = Array.from({ length: 20 }, (_, i) => `src/${'long-directory-name-'.repeat(8)}/file-${i}.ts`);
const { project } = await request('/api/avc', { action: 'create_project', name: 'Receipt capacity regression', files: Object.fromEntries(paths.map(path => [path, 'before\n'])) });
const act = (action, data = {}) => request('/api/avc', { action, project, requestId: crypto.randomUUID(), ...data });
const state = async () => (await request(`/api/avc?project=${project}`)).state;
const original = (await state()).head;
const { journey } = await act('create_journey', { title: 'Integration after extended lease refreshes' });
const { changeset } = await act('create_changeset', { journey, description: 'Change one file after repeated lease refreshes' });
const acquired = await act('acquire', { journey, changeset, revision: original, scopes: paths.map(path => ({ path, start: 1, end: 1, whole: true })) });
const tokens = acquired.locks.map(lock => lock.token);
const historicalRequest = { action: 'refresh', project, journey, requestId: crypto.randomUUID(), tokens };
const historicalResult = await request('/api/avc', historicalRequest);
// Twenty leases refreshed over time exceed the former metadata limit through
// historical receipt snapshots alone. Each refresh remains independently retryable.
for (let i = 0; i < 150; i++) await act('refresh', { journey, tokens });
assert.deepEqual(await request('/api/avc', historicalRequest), historicalResult);
const patched = await act('patch', { journey, changeset, revision: original, description: 'Publish after receipt compression', edits: [{ path: paths[0], content: 'after\n' }], tokens });
await act('declare_breaking', { journey, changes: [] });
await act('submit', { journey, revision: patched.revision, tokens });
await act('review', { journey, revision: patched.revision, kind: 'approve', body: 'Verified metadata and retry preservation' });
const integrated = await act('integrate', { journey, revision: patched.revision, head: original, cursor: 0, tokens });
const final = await state();
assert.equal(final.head, integrated.revision);
assert.equal(final.journeys.find(item => item.id === journey).status, 'integrated');
assert.equal(final.leases.length, 0);
assert.deepEqual(await request('/api/avc', historicalRequest), historicalResult);
console.log('Storage smoke passed: extended lease refresh history, exact receipt replay, approval, and integration after metadata compression.');
