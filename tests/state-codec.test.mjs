import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ProtocolError } from '../lib/avc/core.ts';
import { encodeState, decodeState, MAX_STATE_BYTES, MAX_STORED_STATE_BYTES } from '../lib/avc/state-codec.ts';

const actor = 'agent:0123456789abcdef';
const revision = 'a'.repeat(40);

function fixture(receiptCount = 1) {
    const journey = {
        id: 'journey', title: 'Fix approval and integration', description: 'Review the exact revision before publishing.',
        actor, status: 'review', base: revision, head: revision, reconciledHead: revision, reconciledCursor: 0,
        changesets: [{ id: 'changeset', description: 'Fix workspace behavior', patches: [] }],
        manifest: [], manifestDeclared: true, reviews: [{ id: 'approval', actor: 'human', body: 'Approved.', kind: 'approve', revision, at: 1000 }],
        dispositions: {}, created: 1000,
    };
    const leases = Array.from({ length: 20 }, (_, index) => ({
        id: `lease-${index}`, token: `lease-token-${index}`, generation: index + 1, journey: journey.id,
        changeset: 'changeset', path: `src/module-${index}.ts`, start: 1, end: 20, whole: true,
        revision, anchorRevision: revision, anchorStart: 0, anchorEnd: 20, canonicalStart: 0, canonicalEnd: 20, expires: 601000,
    }));
    const receipts = Object.fromEntries(Array.from({ length: receiptCount }, (_, index) => {
        const requestId = `refresh-${index}`;
        const request = JSON.stringify({ action: 'refresh', project: 'project', journey: journey.id, requestId, tokens: leases.map(lease => lease.token) });
        return [`${actor}:${requestId}`, { request: createHash('sha256').update(request).digest('hex'), result: { locks: leases.map(lease => ({ ...lease, expires: 601000 + index * 60000 })) } }];
    }));
    return {
        id: 'project', name: 'Journey fixture', head: revision,
        revisions: { [revision]: { message: 'Initialize repository', actor: 'human', at: 1000 } },
        journeys: [journey], leases, waiting: [],
        events: [{ id: 1, type: 'review.approve', at: 1000, journey: journey.id, targets: [journey.id], actor: 'human', data: { revision, body: 'Approved.' } }],
        sequence: 1, integrationCursor: 0, generation: 20, receipts, requireApproval: true,
    };
}

function freezeDeep(value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) freezeDeep(child);
    }
    return value;
}

const capacityError = error => error instanceof ProtocolError && error.code === 'project_capacity';

test('small states retain the legacy JSON format and old raw states remain readable', () => {
    const state = fixture();
    const legacy = JSON.stringify(state);
    assert.equal(encodeState(state), legacy);
    assert.deepEqual(decodeState(legacy), state);
});

test('large refresh-receipt history roundtrips without changing fingerprints, lock results, or metadata', () => {
    const state = fixture(260);
    const original = JSON.stringify(state);
    assert(Buffer.byteLength(original) > MAX_STORED_STATE_BYTES);
    const serialized = encodeState(state);
    assert.equal(JSON.parse(serialized).journeyStateEncoding, 'deflate-base64-v1');
    assert(Buffer.byteLength(serialized) < MAX_STORED_STATE_BYTES);
    const restored = decodeState(serialized);
    assert.deepEqual(restored, state);
    assert.deepEqual(restored.receipts, state.receipts);
    for (const [id, receipt] of Object.entries(state.receipts)) {
        assert.equal(restored.receipts[id].request, receipt.request);
        assert.deepEqual(restored.receipts[id].result.locks, receipt.result.locks);
    }
});

test('encoding and decoding frozen metadata never mutate the supplied state', () => {
    for (const state of [fixture(), fixture(260)]) {
        const original = JSON.stringify(state);
        freezeDeep(state);
        assert.deepEqual(decodeState(encodeState(state)), state);
        assert.equal(JSON.stringify(state), original);
        assert.equal(Object.hasOwn(state, 'journeyStateEncoding'), false);
    }
});

test('compressed input cannot inflate beyond the uncompressed metadata bound', () => {
    const state = fixture();
    state.name = 'x'.repeat(MAX_STATE_BYTES);
    const oversized = JSON.stringify(state);
    assert(Buffer.byteLength(oversized) > MAX_STATE_BYTES);
    const serialized = JSON.stringify({ journeyStateEncoding: 'deflate-base64-v1', data: deflateSync(Buffer.from(oversized)).toString('base64') });
    assert(Buffer.byteLength(serialized) < MAX_STORED_STATE_BYTES);
    assert.throws(() => decodeState(serialized), capacityError);
});

test('the uncompressed encode bound counts UTF-8 bytes', () => {
    const state = fixture();
    state.name = 'é'.repeat(MAX_STATE_BYTES / 2);
    const serialized = JSON.stringify(state);
    assert(serialized.length < MAX_STATE_BYTES);
    assert(Buffer.byteLength(serialized) > MAX_STATE_BYTES);
    assert.throws(() => encodeState(state), capacityError);
});

test('incompressible metadata is rejected when the persisted representation is too large', () => {
    const state = fixture();
    state.events = Array.from({ length: 80 }, (_, index) => ({
        id: index + 1, type: 'recording.recorded', at: 1000 + index, journey: 'journey', targets: ['journey'], actor,
        data: { kind: 'command', provenance: 'captured', description: 'Inspect output', command: 'inspect', output: randomBytes(20000).toString('base64'), exitCode: 0 },
    }));
    state.sequence = state.events.length;
    assert(Buffer.byteLength(JSON.stringify(state)) < MAX_STATE_BYTES);
    assert.throws(() => encodeState(state), capacityError);
});

test('malformed wrappers and decoded content fail with an explicit invalid-state error', () => {
    const invalidState = error => error instanceof ProtocolError && error.code === 'invalid_state';
    const wrap = value => JSON.stringify({ journeyStateEncoding: 'deflate-base64-v1', data: deflateSync(Buffer.from(value)).toString('base64') });
    for (const serialized of [
        '{',
        JSON.stringify({ journeyStateEncoding: 'unknown', data: 'AAAA' }),
        JSON.stringify({ journeyStateEncoding: 'deflate-base64-v1', data: '$invalid$' }),
        JSON.stringify({ journeyStateEncoding: 'deflate-base64-v1', data: Buffer.from('not deflated').toString('base64') }),
        wrap('{'),
        wrap('{}'),
    ]) assert.throws(() => decodeState(serialized), invalidState);
});
