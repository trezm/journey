import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeState, encodeState } from '../lib/avc/state-codec.ts';

// This regression modifies only its own repositories in a disposable local Worker.
// Old deadlines are injected through exact-project/version local D1 writes so it
// can reproduce a sleeping watcher without waiting ten minutes or losing scopes.
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = new URL(process.env.AVC_TEST_URL ?? 'http://127.0.0.1:4173');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname), 'Use a disposable loopback Worker.');
assert(['http:', 'https:'].includes(root.protocol) && !root.username && !root.password, 'Use a local HTTP Worker URL without credentials.');
const config = resolve(checkout, process.env.AVC_TEST_WRANGLER_CONFIG ?? 'dist/server/wrangler.json');
const persist = resolve(checkout, process.env.AVC_TEST_PERSIST_DIR ?? '.wrangler/state');
const database = process.env.AVC_TEST_DATABASE ?? 'DB';
const privateDirectory = mkdtempSync(join(tmpdir(), 'journey-posted-locks-smoke-'));
const ownedProjects = new Set();
let cookie = '';
let sqlSequence = 0;

async function request(path, body, credential, expected = 200, code) {
    const response = await fetch(new URL(path, root), {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: {
            ...(credential ? { Authorization: `Bearer ${credential}` } : cookie ? { Cookie: cookie } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    // Never include response bodies in assertion output: leases contain credentials.
    assert.equal(response.status, expected, `Expected HTTP ${expected}; received ${response.status} (${data.code ?? 'no error code'}).`);
    if (code) assert.equal(data.code, code);
    return data.result ?? data;
}

function localSql(command) {
    const path = join(privateDirectory, `fixture-${++sqlSequence}.sql`);
    writeFileSync(path, command, { mode: 0o600 });
    let parsed;
    try {
        const output = execFileSync(process.execPath, [
            join(checkout, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', database,
            '--local', '--config', config, '--persist-to', persist, '--file', path, '--json',
        ], {
            cwd: checkout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env, CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_SEND_METRICS: 'false',
                WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_PATH: join(privateDirectory, 'logs'),
                WRANGLER_REGISTRY_PATH: join(privateDirectory, 'registry'), MINIFLARE_REGISTRY_PATH: join(privateDirectory, 'registry'),
            },
        });
        parsed = JSON.parse(output);
    } catch {
        throw new Error('Disposable local D1 fixture command failed. SQL and captured output are private.');
    }
    assert.equal(parsed[0].success, true, 'Local fixture SQL failed.');
    return parsed[0];
}
const quote = text => `'${text.replaceAll("'", "''")}'`;
function fixtureState(project) {
    assert(ownedProjects.has(project), 'Only repositories created by this regression may be changed.');
    assert.match(project, /^[0-9a-f-]{36}$/);
    const rows = localSql(`SELECT state,version FROM projects WHERE id=${quote(project)};`).results;
    assert.equal(rows.length, 1);
    return { state: decodeState(rows[0].state), version: rows[0].version };
}
function rewriteFixture(project, change) {
    const { state, version } = fixtureState(project);
    change(state);
    localSql(`UPDATE projects SET state=${quote(encodeState(state))},version=version+1 WHERE id=${quote(project)} AND version=${version};`);
    assert.equal(fixtureState(project).version, version + 1, 'Fixture write must match the exact repository version.');
}
function elapsedDeadline(project, journey) {
    rewriteFixture(project, s => {
        const held = s.leases.filter(l => l.journey === journey);
        assert(held.length > 0, 'Deadline fixture must preserve existing scopes.');
        held.forEach(l => { l.expires = Date.now() - 60_000; });
    });
}

async function fixture(title) {
    const { project } = await request('/api/avc', {
        action: 'create_project', name: title,
        files: { 'a.txt': 'A baseline\n', 'b.txt': 'B baseline\n', 'reservation.txt': 'extra reservation\n', 'range.txt': 'one\ntwo\nthree', 'wait.txt': 'wait baseline\n' },
    });
    ownedProjects.add(project);
    const worker = await request('/api/avc', { action: 'create_agent', project, name: 'Disposable worker' });
    const other = await request('/api/avc', { action: 'create_agent', project, name: 'Disposable other worker' });
    const act = (action, body = {}, credential = worker.token, expected = 200, code) => request('/api/avc', { action, project, requestId: crypto.randomUUID(), ...body }, credential, expected, code);
    const state = async () => (await request(`/api/avc?project=${project}`)).state;
    return { project, worker, other, act, state };
}
async function proposal(f, title, path, content, credential = f.worker.token, extraScopes = []) {
    const initial = await f.state();
    const { journey } = await f.act('create_journey', { title }, credential);
    const { changeset } = await f.act('create_changeset', { journey, description: title }, credential);
    const grant = await f.act('acquire', {
        journey, changeset, revision: initial.head, scopes: [{ path, start: 1, end: 1, whole: true }, ...extraScopes],
    }, credential);
    assert.equal(grant.queued, false);
    const tokens = grant.locks.map(l => l.token);
    const patch = await f.act('patch', { journey, changeset, revision: initial.head, tokens, description: title, edits: [{ path, content }] }, credential);
    await f.act('declare_breaking', { journey, changes: [] }, credential);
    await f.act('submit', { journey, revision: patch.revision }, credential); // Existing clients may omit tokens; the server checks actual held coverage.
    return { journey, changeset, revision: patch.revision, tokens, lockIds: grant.locks.map(l => l.id) };
}
function retained(s, entry) {
    const held = s.leases.filter(l => l.journey === entry.journey);
    assert.equal(held.length, entry.lockIds.length, 'Every original submitted reservation must remain held.');
    assert(held.every(l => l.retained === true), 'Submitted reservations must be retained.');
    assert(held.every(l => entry.lockIds.includes(l.id)), 'Posting and reconciliation must preserve existing grants.');
    assert(held.every(l => entry.tokens.includes(l.token)), 'Posting must preserve original tokens.');
    return held;
}
const integratePayload = (f, entry, s, tokens = entry.tokens) => ({
    action: 'integrate', project: f.project, requestId: crypto.randomUUID(), journey: entry.journey,
    revision: entry.revision, head: s.head, cursor: s.integrationCursor, tokens,
});

try {
    await request('/api/auth', { action: 'register', email: `posted-locks-${crypto.randomUUID()}@example.com`, password: 'disposable-local-posted-locks-2026' });
    for (const disposition of ['unaffected', 'adapted']) {
        const f = await fixture(`Retained A/B ${disposition}`);
        const A = await proposal(f, 'A proposed first', 'a.txt', 'A accepted content\n', f.worker.token);
        const B = await proposal(f, 'B proposed before A integration', 'b.txt', 'B initial proposal\n', f.other.token, [{ path: 'reservation.txt', start: 1, end: 1 }]);
        let s = await f.state(); retained(s, A); retained(s, B);
        await f.act('review', { journey: B.journey, revision: B.revision, kind: 'approve' }, null);
        await f.act('review', { journey: A.journey, revision: A.revision, kind: 'approve' }, null);
        elapsedDeadline(f.project, A.journey); elapsedDeadline(f.project, B.journey);
        s = await f.state(); retained(s, A); retained(s, B); // GET must keep posted holds despite old numeric deadlines.
        const acceptedA = await request('/api/avc', integratePayload(f, A, s));
        s = await f.state();
        assert.equal(s.leases.filter(l => l.journey === A.journey).length, 0);
        retained(s, B);
        assert.equal(s.journeys.find(j => j.id === A.journey).status, 'integrated');
        const reconciled = await f.act('reconcile', {
            journey: B.journey, head: s.head, cursor: s.integrationCursor, dispositions: { [acceptedA.event]: disposition },
        }, f.other.token);
        assert.notEqual(reconciled.revision, B.revision);
        assert.equal(reconciled.status, disposition === 'adapted' ? 'working' : 'review');
        s = await f.state(); retained(s, B);
        assert(s.journeys.find(j => j.id === B.journey).reviews.filter(r => r.kind === 'approve').every(r => r.resolved), 'Reconciliation must invalidate prior exact-revision approval.');
        if (disposition === 'unaffected')
            await f.act('integrate', { journey: B.journey, revision: reconciled.revision, head: s.head, cursor: s.integrationCursor, tokens: B.tokens }, null, 409, 'approval_required');
        const patch = await f.act('patch', {
            journey: B.journey, changeset: B.changeset, revision: reconciled.revision, tokens: B.tokens,
            description: 'B update after A integration', edits: [{ path: 'b.txt', content: `B updated after A (${disposition})\n` }],
        }, f.other.token);
        B.revision = patch.revision;
        s = await f.state(); retained(s, B); assert.equal(s.journeys.find(j => j.id === B.journey).status, 'working');
        await f.act('declare_breaking', { journey: B.journey, changes: [] }, f.other.token);
        retained(await f.state(), B);
        await f.act('submit', { journey: B.journey, revision: B.revision, tokens: B.tokens }, f.other.token);
        const changes = await f.act('review', { journey: B.journey, revision: B.revision, kind: 'request_changes', body: 'Resolve this review before integration.' }, null);
        elapsedDeadline(f.project, B.journey);
        s = await f.state(); retained(s, B);
        elapsedDeadline(f.project, B.journey); // Exercise the mutation expiry sweep without an intervening GET.
        await f.act('record', { journey: B.journey, kind: 'explanation', provenance: 'captured', description: 'Posted reservations survive review requests and elapsed deadlines.' }, f.other.token);
        retained(await f.state(), B); // A mutation must not expire retained scopes either.
        await f.act('submit', { journey: B.journey, revision: B.revision, tokens: B.tokens }, f.other.token, 409, 'changes_requested');
        await request('/api/avc', integratePayload(f, B, s), null, 409, 'changes_requested');
        await f.act('resolve_review', { journey: B.journey, review: changes.review }, f.other.token);
        await f.act('declare_breaking', { journey: B.journey, changes: [] }, f.other.token);
        await f.act('submit', { journey: B.journey, revision: B.revision }, f.other.token);
        await f.act('review', { journey: B.journey, revision: reconciled.revision, kind: 'approve' }, null, 409, 'stale_review');
        await f.act('review', { journey: B.journey, revision: B.revision, kind: 'approve' }, null);
        elapsedDeadline(f.project, B.journey);
        s = await f.state(); retained(s, B);
        for (const credential of [null, f.other.token]) {
            await request('/api/avc', integratePayload(f, B, s, []), credential, 409, 'invalid_lease');
            await request('/api/avc', integratePayload(f, B, s, B.tokens.slice(0, 1)), credential, 409, 'invalid_lease');
        }
        await request('/api/avc', { ...integratePayload(f, B, s, []), owner: true, agent: false, user: { agent: false } }, f.other.token, 409, 'invalid_lease');
        const credential = disposition === 'adapted' ? f.other.token : null;
        const payload = integratePayload(f, B, s);
        const acceptedB = await request('/api/avc', payload, credential);
        const after = await f.state();
        assert.equal(after.leases.length, 0);
        assert.equal(after.journeys.find(j => j.id === B.journey).status, 'integrated');
        assert.equal(after.events.filter(e => e.type === 'journey.integrated' && e.journey === B.journey).length, 1);
        const files = (await request(`/api/avc?project=${f.project}&revision=${after.head}`)).files;
        assert.equal(files['a.txt'], 'A accepted content\n');
        assert.equal(files['b.txt'], `B updated after A (${disposition})\n`);
        assert.deepEqual(await request('/api/avc', payload, credential), acceptedB);
        assert.equal((await f.state()).sequence, after.sequence);
        await request('/api/avc', { ...payload, cursor: payload.cursor + 1 }, credential, 409, 'idempotency_conflict');
    }

    // Abandonment returns durable scopes and wakes a queued contender. Its later
    // unposted grant must still expire even if it supplies a forged retained flag.
    {
        const f = await fixture('Abandonment and ordinary expiry');
        const posted = await proposal(f, 'Submitted reservation to abandon', 'wait.txt', 'posted wait content\n');
        const initial = await f.state();
        const { journey } = await f.act('create_journey', { title: 'Queued unposted contender' }, f.other.token);
        const { changeset } = await f.act('create_changeset', { journey, description: 'Wait for retained scope' }, f.other.token);
        const body = { journey, changeset, revision: initial.head, retained: true, scopes: [{ path: 'wait.txt', start: 1, end: 1, whole: true, retained: true }] };
        assert.equal((await f.act('acquire', body, f.other.token)).queued, true);
        elapsedDeadline(f.project, posted.journey);
        retained(await f.state(), posted);
        await f.act('abandon', { journey: posted.journey });
        let s = await f.state();
        assert.equal(s.leases.filter(l => l.journey === posted.journey).length, 0);
        assert(s.events.some(e => e.type === 'lock.available' && e.targets.includes(journey)), 'Abandonment must notify the queued contender.');
        const grant = await f.act('acquire', body, f.other.token);
        assert.equal(grant.queued, false);
        assert(grant.locks.every(l => !l.retained), 'A caller must not turn an unposted reservation into a permanent hold.');
        const tokens = grant.locks.map(l => l.token);
        const patch = await f.act('patch', { journey, changeset, revision: initial.head, tokens, description: 'Published but unsubmitted change', edits: [{ path: 'wait.txt', content: 'ordinary unposted content\n' }] }, f.other.token);
        await f.act('declare_breaking', { journey, changes: [] }, f.other.token);
        elapsedDeadline(f.project, journey);
        s = await f.state();
        assert.equal(s.leases.filter(l => l.journey === journey).length, 0, 'Normal unpublished/unsubmitted grants must expire.');
        assert(s.events.some(e => e.type === 'lock.expired' && e.journey === journey));
        await f.act('submit', { journey, revision: patch.revision, retained: true }, f.other.token, 409, 'locks_required');
    }

    // First posting must validate the entire immutable delta before retaining any
    // scope. Expiring one real grant leaves a valid partial reservation, not
    // permission to permanently hold that reservation through a failed Submit.
    {
        const f = await fixture('First submission atomic full coverage');
        const initial = await f.state();
        const { journey } = await f.act('create_journey', { title: 'Never-posted two-file candidate' });
        const { changeset } = await f.act('create_changeset', { journey, description: 'Publish two complete files' });
        const grant = await f.act('acquire', { journey, changeset, revision: initial.head, scopes: [
            { path: 'a.txt', start: 1, end: 1, whole: true }, { path: 'b.txt', start: 1, end: 1, whole: true },
        ] });
        assert.equal(grant.queued, false);
        const patch = await f.act('patch', {
            journey, changeset, revision: initial.head, tokens: grant.locks.map(l => l.token),
            description: 'Immutable two-file delta', edits: [
                { path: 'a.txt', content: 'atomic A update\n' }, { path: 'b.txt', content: 'atomic B update\n' },
            ],
        });
        await f.act('declare_breaking', { journey, changes: [] });
        rewriteFixture(f.project, s => {
            assert(!s.journeys.find(j => j.id === journey).posted);
            const expiring = s.leases.filter(l => l.journey === journey && l.path === 'b.txt');
            assert.equal(expiring.length, 1);
            expiring.forEach(l => { l.expires = Date.now() - 60_000; });
        });
        const before = await f.state();
        const remaining = before.leases.filter(l => l.journey === journey);
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].path, 'a.txt');
        assert(!remaining[0].retained);
        const requestId = crypto.randomUUID();
        await request('/api/avc', {
            action: 'submit', project: f.project, requestId, journey, revision: patch.revision,
            tokens: remaining.map(l => l.token),
        }, f.worker.token, 409, 'lock_coverage');
        const after = fixtureState(f.project).state;
        assert(!after.journeys.find(j => j.id === journey).posted, 'Failed first posting must not mark the Journey as posted.');
        assert(after.leases.filter(l => l.journey === journey).every(l => !l.retained), 'Failed first posting must not retain partial scopes.');
        assert(!after.events.some(e => e.type === 'review.requested' && e.journey === journey));
        assert(!Object.hasOwn(after.receipts, `${f.worker.actor}:${requestId}`), 'Failed first posting must not record a successful receipt.');
        assert.equal(after.sequence, before.sequence, 'Failed first posting must not emit an event.');
    }

    // Existing live legacy review grants may migrate; genuinely expired legacy
    // grants cannot be resurrected from historical patches, reviews, or tokens.
    {
        const f = await fixture('Legacy review migration and strict final coverage');
        const entry = await proposal(f, 'Legacy submitted review', 'range.txt', 'ONE\ntwo\nthree');
        await f.act('review', { journey: entry.journey, revision: entry.revision, kind: 'approve' }, null);
        rewriteFixture(f.project, s => {
            delete s.journeys.find(j => j.id === entry.journey).posted;
            s.leases.filter(l => l.journey === entry.journey).forEach(l => { delete l.retained; l.expires = Date.now() + 60_000; });
        });
        retained(await f.state(), entry);
        rewriteFixture(f.project, s => {
            delete s.journeys.find(j => j.id === entry.journey).posted;
            s.leases.filter(l => l.journey === entry.journey).forEach(l => { delete l.retained; l.expires = Date.now() - 60_000; });
        });
        let s = await f.state();
        assert.equal(s.leases.filter(l => l.journey === entry.journey).length, 0);
        await f.act('record', { journey: entry.journey, kind: 'explanation', provenance: 'captured', description: 'Legacy missing grants must be explicitly reacquired.' });
        assert.equal((await f.state()).leases.filter(l => l.journey === entry.journey).length, 0);
        await f.act('submit', { journey: entry.journey, revision: entry.revision }, f.worker.token, 409, 'locks_required');
        for (const credential of [null, f.worker.token])
            await request('/api/avc', integratePayload(f, entry, s), credential, 409, 'locks_required');
        const partial = await f.act('acquire', { journey: entry.journey, changeset: entry.changeset, revision: entry.revision, scopes: [{ path: 'range.txt', start: 3, end: 3 }] });
        assert.equal(partial.queued, false);
        assert(partial.locks.every(l => l.retained), 'New legitimate acquisitions for a posted Journey remain retained.');
        const partialTokens = partial.locks.map(l => l.token);
        s = await f.state();
        for (const credential of [null, f.worker.token])
            await request('/api/avc', integratePayload(f, entry, s, partialTokens), credential, 409, 'lock_coverage');
        await f.act('submit', { journey: entry.journey, revision: entry.revision, tokens: partialTokens }, f.worker.token, 409, 'lock_coverage');
        const whole = await f.act('acquire', { journey: entry.journey, changeset: entry.changeset, revision: entry.revision, scopes: [{ path: 'range.txt', start: 1, end: 1, whole: true }] });
        assert.equal(whole.queued, false);
        const fullTokens = [...partialTokens, ...whole.locks.map(l => l.token)];
        s = await f.state();
        await request('/api/avc', integratePayload(f, entry, s, whole.locks.map(l => l.token)), null, 409, 'invalid_lease');
        await request('/api/avc', integratePayload(f, entry, s, fullTokens));
        assert.equal((await f.state()).leases.filter(l => l.journey === entry.journey).length, 0);
    }
    console.log('Posted locks API regression passed: submitted A/B reservations survive elapsed deadlines, both reconciliation dispositions, updates and review requests; owner/worker integration requires every token and final coverage; integration/abandonment release scopes; ordinary expiry, forged permanence and legacy missing-grant recovery stay safe.');
} finally {
    rmSync(privateDirectory, { recursive: true, force: true });
}
