import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonFetch, JsonResponseError, PendingIntegrationRequests, RequestTimeoutError } from '../lib/avc/client.ts';

test('a stalled request releases its wait and aborts the connection', async t => {
    let signal;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
    });
    await assert.rejects(jsonFetch('/api/avc', undefined, 10), RequestTimeoutError);
    assert.equal(signal.aborted, true);
});

test('a stalled response body also times out', async t => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: () => new Promise(() => {}) }));
    await assert.rejects(jsonFetch('/api/avc', undefined, 10), RequestTimeoutError);
});

test('completed requests preserve data and server rejection details', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ result: { revision: 'accepted' } }));
    assert.deepEqual(await jsonFetch('/api/avc', undefined, 10), { result: { revision: 'accepted' } });
    fetch.mock.mockImplementation(async () => Response.json({ error: 'Approval required.', code: 'approval_required' }, { status: 409 }));
    await assert.rejects(jsonFetch('/api/avc', undefined, 10), error => error instanceof JsonResponseError && error.message === 'Approval required.' && error.status === 409 && error.code === 'approval_required');
});

test('manual integration retry keeps the identical payload and request ID after an uncertain timeout', async t => {
    const requests = new PendingIntegrationRequests();
    const bodies = [];
    const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
        bodies.push(init.body);
        return new Promise(() => {});
    });
    const first = requests.body('project', 'journey', { revision: 'revision', head: 'main', cursor: 1, tokens: ['original'] });
    await assert.rejects(jsonFetch('/api/avc', { method: 'POST', body: first }, 10), RequestTimeoutError);
    fetch.mock.mockImplementation(async (_url, init) => {
        bodies.push(init.body);
        return Response.json({ result: { revision: 'accepted' } });
    });
    const retry = requests.body('project', 'journey', { revision: 'revision', head: 'updated-main', cursor: 2, tokens: ['refreshed'] });
    assert.deepEqual(await jsonFetch('/api/avc', { method: 'POST', body: retry }, 10), { result: { revision: 'accepted' } });
    assert.equal(bodies[0], bodies[1]);
    assert.equal(JSON.parse(retry).requestId, JSON.parse(first).requestId);
    assert.deepEqual(JSON.parse(retry).tokens, ['original']);
    requests.settle('project', 'journey');
    assert.notEqual(JSON.parse(requests.body('project', 'journey', { revision: 'next' })).requestId, JSON.parse(first).requestId);
    assert.equal(JSON.parse(requests.body('another-project', 'journey', { revision: 'other' })).project, 'another-project');
});
