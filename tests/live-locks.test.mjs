import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquire, expire, finalizeIntegration, submitForReview } from '../lib/avc/core.ts';
import { liveSnapshot } from '../lib/avc/live.ts';
import { GitStore } from '../lib/avc/git.ts';
import { decodeState, encodeState } from '../lib/avc/state-codec.ts';

const now = 1000;
const text = { 'file.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight' };
function fixture(head = 'main') {
    return { id: 'repo', name: 'Repo', head, revisions: {}, journeys: [], leases: [], waiting: [], events: [], sequence: 0, integrationCursor: 0, generation: 0, receipts: {}, requireApproval: true };
}
function journey(state, id) {
    const result = { id, title: `${id} title`, description: `${id} description`, actor: id, status: 'working', base: state.head, head: state.head, reconciledHead: state.head, reconciledCursor: 0, changesets: [{ id: `${id}-step`, description: `${id} step`, patches: [] }], manifest: [], manifestDeclared: true, reviews: [], dispositions: {}, created: now };
    state.journeys.push(result); return result;
}
function request(state, owner, scopes, files = text, revision = state.head) {
    return acquire(state, owner, owner.changesets[0].id, scopes, revision, files, text, owner.actor, now);
}
const scope = (start, end = start, path = 'file.txt') => ({ path, start, end });
const snapshot = (state, time = now) => liveSnapshot(state, async () => text, time);
const fileRegions = value => value.files.find(file => file.path === 'file.txt').regions;
const region = (value, line) => fileRegions(value).find(item => item.start <= line && item.end >= line);

test('disjoint canonical regions implement blue/yellow/red and unique request counts', async () => {
    const state = fixture(), owner = journey(state, 'owner'), first = journey(state, 'first'), second = journey(state, 'second');
    const granted = request(state, owner, [scope(2, 7)]);
    const a = request(state, first, [scope(3, 5), scope(4, 5)]), b = request(state, second, [scope(5, 6)]);
    const result = await snapshot(state);
    assert.deepEqual(fileRegions(result).map(({ start, end, status }) => ({ start, end, status })), [
        { start: 2, end: 2, status: 'locked' }, { start: 3, end: 4, status: 'waiting' },
        { start: 5, end: 5, status: 'contended' }, { start: 6, end: 6, status: 'waiting' }, { start: 7, end: 7, status: 'locked' },
    ]);
    assert.deepEqual(region(result, 5).waitingIds, [a.requestId, b.requestId].sort());
    assert.deepEqual(region(result, 5).lockIds, [granted.locks[0].id]);
    assert.deepEqual(region(result, 5).changesetIds, ['first-step', 'owner-step', 'second-step']);
    assert.equal(result.summary.waitingCount, 2); assert.equal(result.summary.contendedRegions, 1);
    assert.equal(result.changesets.find(item => item.id === 'first-step').waitingCount, 1);
    assert(!JSON.stringify(result).includes(granted.locks[0].token));
    assert(!JSON.stringify(result).includes(text['file.txt']));
});

test('retry keeps one request identity but replaces stale scopes and source revision', async () => {
    const state = fixture(), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    request(state, holder, [scope(1, 8)]);
    const first = request(state, waiter, [scope(2)]);
    const revision = 'updated-source', updated = { 'file.txt': 'new\n' + text['file.txt'] };
    const second = request(state, waiter, [scope(7)], updated, revision);
    assert.equal(first.requestId, second.requestId); assert.equal(state.waiting.length, 1);
    assert.equal(state.waiting[0].revision, revision); assert.deepEqual(state.waiting[0].scopes, [scope(7)]);
    const count = state.sequence;
    request(state, waiter, [scope(7)], updated, revision);
    assert.equal(state.sequence, count, 'Unchanged polling retry does not create queue events.');
    assert.equal(state.events.filter(event => event.type === 'lock.queue_updated').length, 1);
    const result = await liveSnapshot(state, async hash => hash === revision ? updated : text, now);
    assert.equal(region(result, 2).status, 'locked');
    assert.equal(region(result, 6).status, 'waiting'); assert.equal(region(result, 6).approximate, false);
    assert.equal(result.summary.waitingCount, 1);
});

test('availability is not a grant; expiry drops only live colors, retry consumes queue', async () => {
    const state = fixture(), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    request(state, holder, [scope(3)]); request(state, waiter, [scope(3)]);
    expire(state, now + 600001);
    const available = await snapshot(state, now + 600001);
    assert.equal(region(available, 3).status, 'waiting'); assert.deepEqual(region(available, 3).lockIds, []);
    assert.equal(state.waiting.length, 1); assert(state.events.some(event => event.type === 'lock.available'));
    assert.equal(request(state, waiter, [scope(3)]).queued, false);
    assert.equal((await snapshot(state)).summary.waitingCount, 0);
});

test('posted retention and integration release agree with protocol lifecycle', async () => {
    const state = fixture(), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    request(state, holder, [scope(2)]);
    holder.changesets[0].patches.push({ id: 'patch', changes: [{ path: 'file.txt', hunks: [] }] });
    submitForReview(state, holder, holder.head, holder.actor, undefined, now);
    state.leases[0].expires = now - 1;
    assert.equal(region(await snapshot(state, now + 900000), 2).status, 'locked');
    request(state, waiter, [scope(2)]);
    finalizeIntegration(state, holder, 'integrated', holder.actor, text, text);
    const result = await snapshot(state);
    assert.equal(region(result, 2).status, 'waiting'); assert.deepEqual(region(result, 2).lockIds, []);
    assert.equal(result.changesets.find(item => item.id === 'holder-step').lockCount, 0);
    assert.equal(result.changesets.find(item => item.id === 'holder-step').status, 'integrated');
});

test('expired, abandoned and integrated holders or waiters do not survive in live counts', async () => {
    const state = fixture(), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    request(state, holder, [scope(2)]); request(state, waiter, [scope(2)]);
    state.leases[0].expires = now - 1; waiter.status = 'abandoned';
    const result = await snapshot(state);
    assert.deepEqual(fileRegions(result), []); assert.equal(result.summary.waitingCount, 0);
    state.leases[0].retained = true; holder.status = 'integrated';
    assert.deepEqual(fileRegions(await snapshot(state)), []);
});

test('canonical lease coordinates override journey lines and waiting projection flags changed content', async () => {
    const state = fixture(), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    request(state, holder, [scope(3, 4)]); request(state, waiter, [scope(3)]);
    state.leases[0].start = 70; state.leases[0].end = 80;
    state.waiting[0].revision = 'old';
    const result = await liveSnapshot(state, async revision => revision === 'old' ? { 'file.txt': 'one\ntwo\nCHANGED\nfour\nfive\nsix\nseven\neight' } : text, now);
    assert.equal(region(result, 3).approximate, true);
    assert.equal(region(result, 4).status, 'locked'); assert.equal(region(result, 4).approximate, false);
    assert.equal(region(result, 70), undefined);
});

test('conservative adjacent conflicts do not fabricate an overlap in displayed lines', async () => {
    const state = fixture(), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    request(state, holder, [scope(2)]);
    assert.equal(request(state, waiter, [scope(3)]).queued, true);
    const result = await snapshot(state);
    assert.equal(region(result, 2).status, 'locked'); assert.equal(region(result, 3).status, 'waiting');
    assert.deepEqual(region(result, 3).lockIds, []);
});

test('new and empty files, historical deleted paths and same request over multiple paths remain visible', async () => {
    const state = fixture(), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    const whole = path => ({ path, start: 1, end: 1, whole: true });
    request(state, holder, [whole('new.txt')]);
    request(state, waiter, [whole('new.txt')]);
    state.leases.push({ ...state.leases[0], id: 'prototype-path', path: '__proto__' });
    state.waiting[0].scopes.push(whole('__proto__'));
    holder.changesets[0].patches.push({ id: 'historic', changes: [{ path: 'deleted.txt', hunks: [{ start: 100, count: 10, lines: [] }] }] });
    const result = await liveSnapshot(state, async () => ({ ...text, 'empty.txt': '' }), now);
    for (const path of ['new.txt', '__proto__']) {
        const entry = result.files.find(file => file.path === path);
        assert.equal(entry.exists, false); assert.equal(entry.lineCount, 1); assert.equal(entry.regions[0].status, 'waiting');
    }
    assert.deepEqual(result.files.find(file => file.path === 'deleted.txt'), { path: 'deleted.txt', exists: false, lineCount: 1, regions: [] });
    assert.deepEqual(result.files.find(file => file.path === 'empty.txt'), { path: 'empty.txt', exists: true, lineCount: 1, regions: [] });
    assert.equal(result.summary.waitingCount, 1); assert.equal(result.changesets.find(item => item.id === 'waiter-step').waitingCount, 1);
    assert.deepEqual(result.changesets.find(item => item.id === 'holder-step').paths, ['__proto__', 'deleted.txt', 'new.txt']);
});

test('collapsed or clamped held spans and missing queued spans are explicitly approximate', async () => {
    const state = fixture(), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    request(state, holder, [scope(2)]); request(state, waiter, [scope(2)]);
    state.leases[0].canonicalStart = 1; state.leases[0].canonicalEnd = 1;
    let result = await snapshot(state);
    assert.equal(region(result, 2).approximate, true);
    state.leases[0].canonicalStart = 7; state.leases[0].canonicalEnd = 12;
    result = await snapshot(state);
    assert.equal(region(result, 8).approximate, true);
    state.waiting[0].scopes = [scope(2, 2, 'gone.txt')]; state.waiting[0].revision = 'old';
    result = await liveSnapshot(state, async revision => revision === 'old' ? { 'gone.txt': 'one\ntwo\nthree' } : text, now);
    const missing = result.files.find(file => file.path === 'gone.txt');
    assert.equal(missing.exists, false); assert.equal(missing.regions[0].approximate, true);
    assert.deepEqual([missing.regions[0].start, missing.regions[0].end], [1, 1]);
});

test('historical reads are cached by revision, serial, and snapshot construction does not mutate state', async () => {
    const state = fixture(), holder = journey(state, 'holder'); request(state, holder, [scope(1, 8)]);
    for (let i = 0; i < 6; i++) {
        const waiter = journey(state, `waiter-${i}`); request(state, waiter, [scope(3), scope(3, 4)]);
        state.waiting.at(-1).revision = i < 3 ? 'old-one' : 'old-two';
    }
    state.waiting.push(structuredClone(state.waiting[0])); // Legacy duplicate identity must not inflate counts.
    const original = structuredClone(state), calls = [], inFlight = new Set();
    const result = await liveSnapshot(state, async revision => {
        assert.equal(inFlight.size, 0); inFlight.add(revision); calls.push(revision);
        await Promise.resolve(); inFlight.delete(revision); return text;
    }, now);
    assert.deepEqual(calls, ['main', 'old-one', 'old-two']); assert.deepEqual(state, original);
    assert.equal(result.summary.waitingCount, 6); assert.equal(region(result, 3).waitingIds.length, 6);
    assert.equal(result.head, state.head); assert.equal(result.sequence, state.sequence); assert.equal(result.updatedAt, now);
});

test('actual live HTTP handler authenticates, strips private data and expires grants before snapshot', async t => {
    const checkout = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const envModule = 'data:text/javascript,' + encodeURIComponent('export const env = globalThis.__liveTestEnvironment;');
    const hooks = registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'cloudflare:workers') return { url: envModule, shortCircuit: true };
        if (specifier.startsWith('@/')) return next(pathToFileURL(checkout + '/' + specifier.slice(2) + '.ts').href, context);
        return next(specifier, context);
    } });
    const db = { rows: new Map(), agents: new Map(), prepare(sql) { return { bind(...args) { return {
        async first() {
            if (sql.startsWith('SELECT project,name,role FROM agents')) return db.agents.get(args[0]) ?? null;
            if (sql.startsWith('SELECT id,owner,name,version,state FROM projects')) return structuredClone(db.rows.get(args[0]) ?? null);
            throw Error('Unexpected query: ' + sql);
        },
        async run() {
            if (sql.startsWith('UPDATE projects SET state=')) {
                const row = db.rows.get(args[1]);
                if (row.version !== args[2]) return { meta: { changes: 0 } };
                row.state = args[0]; row.version++; return { meta: { changes: 1 } };
            }
            throw Error('Unexpected write: ' + sql);
        },
    }; } }; } };
    const objects = new Map(), bucket = {
        async get(key) { const value = objects.get(key); return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength), text: async () => new TextDecoder().decode(value) } : null; },
        async put(key, value) { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)); },
    };
    globalThis.__liveTestEnvironment = { DB: db, BUCKET: bucket };
    t.after(() => { hooks.deregister(); delete globalThis.__liveTestEnvironment; });
    const { GET } = await import('../app/api/avc/route.ts'), { digest } = await import('../lib/avc/auth.ts');
    db.agents.set(await digest('local-test-agent'), { project: 'repo', name: 'Reader', role: 'worker' });
    const git = new GitStore(bucket, 'repo'), commit = await git.save(text, undefined, 'Initial', 'Owner');
    const state = fixture(commit.oid), holder = journey(state, 'holder'), waiter = journey(state, 'waiter');
    request(state, holder, [scope(3)]); request(state, waiter, [scope(3)]);
    state.receipts.private = { token: 'private-receipt-token' };
    db.rows.set('repo', { id: 'repo', owner: 'owner', name: 'Repo', version: 0, state: encodeState(state) });
    const get = (project = 'repo', headers = { Authorization: 'Bearer local-test-agent' }) => GET(new Request(`http://localhost/api/avc?project=${project}&live=1`, { headers }));
    assert.equal((await get('repo', {})).status, 401); assert.equal((await get('other')).status, 403);
    const response = await get(), result = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(result).sort(), ['changesets', 'files', 'head', 'sequence', 'summary', 'updatedAt']);
    assert.equal(result.head, commit.oid); assert.equal(result.summary.waitingCount, 1);
    assert.deepEqual(region(result, 3).lockIds, []); assert.equal(region(result, 3).status, 'waiting');
    assert.equal(decodeState(db.rows.get('repo').state).leases.length, 0);
    assert.equal(/private-receipt-token|local-test-agent|canonicalStart|"token"|"receipts"/.test(JSON.stringify(result)), false);
});
