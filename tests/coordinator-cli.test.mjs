import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicCLI = fileURLToPath(new URL('../public/journey.mjs', import.meta.url));
const agentCLI = fileURLToPath(new URL('../cli/agent.mjs', import.meta.url));
const revision = 'a'.repeat(40), nextRevision = 'b'.repeat(40), canonical = 'c'.repeat(40);
const project = '12345678-1234-1234-1234-123456789012';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const row = (journey = 'worker-ready', changes = {}) => ({ journey, title: journey, actor: 'agent:worker', revision, reconciledHead: canonical, reconciledCursor: 2, reviewable: true, approved: false, ready: true, reasons: [], ...changes });
const feed = (changes = {}) => ({ policy: { requireApproval: true, allowWorkerMerge: true, allowCoordinatorApproval: true }, canApprove: true, head: canonical, integrationCursor: 2, cursor: 10, queue: [row()], events: [], ...changes });

async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'journey-coordinator-cli-'));
    await mkdir(join(directory, '.journey'));
    const requests = [], children = [];
    const context = { queue: feed(), user: { id: 'agent:coordinator', agent: true, role: 'coordinator' }, ...options };
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            let text = ''; for await (const chunk of req) text += chunk;
            const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, ...(text ? { body: JSON.parse(text) } : {}) };
            requests.push(call);
            let result;
            if (context.handle) result = await context.handle(call);
            if (!result) result = call.method === 'POST' ? { data: { result: { review: 'review-created' } } } : call.query.approvals ? { data: context.queue } : { data: { state: { journeys: [], leases: [] }, user: context.user } };
            res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.data));
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const profile = join(directory, 'connection.json');
    await writeFile(profile, JSON.stringify({ url, project, token: 'mock-coordinator-token', siteToken: 'mock-sites-token' }));
    await writeFile(join(directory, '.journey/config.json'), JSON.stringify({ connection: profile }));
    const env = { ...process.env, JOURNEY_CONNECTION: profile, JOURNEY_CONFIG_HOME: join(directory, 'credentials'), AVC_URL: url, AVC_PROJECT: project, AVC_TOKEN: 'mock-coordinator-token', AVC_SITE_SERVICE_TOKEN: 'mock-sites-token' };
    function launch(args, cli = publicCLI) {
        const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
        let stdout = '', stderr = '';
        child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
        const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
        return { child, completion };
    }
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
    });
    return { context, directory, requests, launch, run: (args, cli) => launch(args, cli).completion };
}

async function until(check, ms = 14000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const result = await check(); if (result) return result; await pause(40); }
    throw new Error('Timed out waiting for coordinator watcher.');
}

test('coordinator inbox and approvals expose repository readiness without an active journey', async t => {
    const f = await fixture(t);
    const inbox = await f.run(['inbox', '7']);
    assert.equal(inbox.code, 0, inbox.stderr); assert.deepEqual(JSON.parse(inbox.stdout).queue, [row()]);
    assert.deepEqual(f.requests[0].query, { project, approvals: '1', since: '7' });
    const approvals = await f.run(['approvals', '8']);
    assert.equal(approvals.code, 0, approvals.stderr); assert.equal(f.requests[1].query.since, '8');
    assert(f.requests.every(r => r.query.approvals === '1' && !r.query.journey));
    assert.equal(f.requests[0].headers['oai-sites-authorization'], 'Bearer mock-sites-token');
    const invalid = await f.run(['approvals', '-1']);
    assert.equal(invalid.code, 1); assert.match(invalid.stderr, /invalid_cursor/); assert.equal(f.requests.length, 2);
});

test('coordinator watch persists separate cursors, invalidates readiness and stays quiet on restart', { timeout: 30000 }, async t => {
    const blocked = row('worker-blocked', { ready: false, reviewable: false, reasons: ['reconciliation_required'] });
    const f = await fixture(t, { queue: feed({ cursor: 11, queue: [row(), blocked], events: [{ id: 11, type: 'review.requested', journey: 'worker-ready' }] }) });
    await writeFile(join(f.directory, '.journey/cursor'), '999');
    await writeFile(join(f.directory, '.journey/inbox.jsonl'), 'existing worker inbox\n');
    await writeFile(join(f.directory, '.journey/coordinator-cursor'), '7');
    const watching = f.launch(['watch']);
    await until(async () => (await readFile(join(f.directory, '.journey/coordinator-cursor'), 'utf8').catch(() => '')) === '11');
    f.context.queue = feed({ cursor: 12, queue: [row('worker-ready', { revision: nextRevision, reviewable: false, ready: false, reasons: ['manifest_required'] }), blocked, row('worker-new')], events: [{ id: 12, type: 'patch.recorded', journey: 'worker-ready' }] });
    await until(async () => (await readFile(join(f.directory, '.journey/coordinator-cursor'), 'utf8').catch(() => '')) === '12');
    f.context.queue = feed({ cursor: 13, policy: { requireApproval: true, allowWorkerMerge: true, allowCoordinatorApproval: false }, canApprove: false, queue: [row('worker-new', { ready: false, reasons: ['coordinator_approval_disabled'] })], events: [{ id: 13, type: 'policy.changed' }] });
    await until(async () => (await readFile(join(f.directory, '.journey/coordinator-cursor'), 'utf8').catch(() => '')) === '13');
    watching.child.kill('SIGTERM'); await watching.completion;
    assert.equal(f.requests[0].query.since, '7'); assert.equal(f.requests[1].query.since, '11'); assert.equal(f.requests[2].query.since, '12');
    assert(f.requests.every(r => r.method === 'GET' && r.query.approvals === '1' && !r.query.journey));
    assert.equal(await readFile(join(f.directory, '.journey/cursor'), 'utf8'), '999');
    assert.equal(await readFile(join(f.directory, '.journey/inbox.jsonl'), 'utf8'), 'existing worker inbox\n');
    const events = (await readFile(join(f.directory, '.journey/coordinator-inbox.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter(e => e.id).map(e => e.id), [11, 12, 13]);
    const changes = events.filter(e => e.type === 'approvals.queue_changed');
    assert.equal(changes.length, 3); assert.deepEqual(changes[0].ready, ['worker-ready']); assert.deepEqual(changes[1].ready, ['worker-new']); assert.deepEqual(changes[2].ready, []);
    const log = await readFile(join(f.directory, '.journey/watcher.log'), 'utf8');
    assert.match(log, /ready IDs: worker-ready/); assert.match(log, /ready IDs: worker-new/); assert.match(log, /ready IDs: none/); assert(!log.includes('worker-blocked'));
    // Restart from persisted state: replay neither a readiness notification nor an old event.
    f.context.queue = { ...f.context.queue, events: [] };
    const restarted = f.launch(['watch']);
    await until(() => f.requests.length >= 4);
    await until(async () => (await readFile(join(f.directory, '.journey/coordinator-cursor'), 'utf8')) === '13');
    restarted.child.kill('SIGTERM'); await restarted.completion;
    assert.equal(f.requests[3].query.since, '13');
    assert.equal((await readFile(join(f.directory, '.journey/coordinator-inbox.jsonl'), 'utf8')).trim().split('\n').length, 6);
});

test('approve requires an explicit exact revision and sends coordinator review authority', async t => {
    const f = await fixture(t);
    for (const args of [['approve', 'worker-ready'], ['approve', 'worker-ready', revision.slice(0, 8)]]) {
        const result = await f.run(args); assert.equal(result.code, 1); assert.match(result.stderr, /exact-40-character-revision/);
    }
    assert.equal(f.requests.length, 0);
    const result = await f.run(['approve', 'worker-ready', revision, 'Reviewed all patches and manifest']);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).review, 'review-created');
    assert.equal(f.requests.length, 3);
    const body = f.requests[2].body;
    assert.equal(body.action, 'review'); assert.equal(body.kind, 'approve'); assert.equal(body.journey, 'worker-ready'); assert.equal(body.revision, revision); assert.equal(body.authority, 'coordinator'); assert.equal(body.body, 'Reviewed all patches and manifest');
    assert(body.requestId); assert.equal(body.project, project);
});

test('disabled permission, blocked readiness, granted approvals, self exclusion and stale hashes prevent approval requests', async t => {
    const f = await fixture(t);
    const cases = [
        [feed({ canApprove: false, queue: [row('worker-ready', { ready: false, reasons: ['coordinator_approval_disabled'] })] }), revision, /coordinator_approval_disabled/],
        [feed({ queue: [row('worker-ready', { reviewable: false, ready: false, reasons: ['reconciliation_required'] })] }), revision, /reconciliation_required/],
        [feed({ queue: [row('worker-ready', { approved: true, ready: false, reasons: ['approval_already_granted'] })] }), revision, /approval_already_granted/],
        [feed({ queue: [] }), revision, /not_in_review/],
        [feed({ queue: [row('worker-ready', { revision: nextRevision })] }), revision, /stale_review/],
    ];
    for (const [queue, hash, error] of cases) { f.context.queue = queue; const result = await f.run(['approve', 'worker-ready', hash]); assert.equal(result.code, 1); assert.match(result.stderr, error); }
    assert(f.requests.every(r => r.method === 'GET' && r.query.approvals === '1'));
});

test('human review is marked explicitly, and a server-side change after polling stays rejected', async t => {
    const f = await fixture(t, { user: { id: 'owner', agent: false } });
    const result = await f.run(['approve', 'worker-ready', revision]);
    assert.equal(result.code, 0, result.stderr); assert.equal(f.requests[2].body.authority, 'human');
    f.context.handle = call => call.method === 'POST' ? { status: 409, data: { code: 'stale_review', error: 'This review targets an old revision.' } } : undefined;
    const changed = await f.run(['approve', 'worker-ready', revision]);
    assert.equal(changed.code, 1); assert.match(changed.stderr, /stale_review/);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
});

test('worker credentials cannot read the coordinator feed or post an approval', async t => {
    const f = await fixture(t, { handle: call => call.query.approvals ? { status: 403, data: { code: 'forbidden', error: 'Approval feed requires a repository coordinator.' } } : undefined });
    const result = await f.run(['approve', 'worker-ready', revision]);
    assert.equal(result.code, 1); assert.match(result.stderr, /forbidden/); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'GET');
});

test('standalone agent tooling polls repository approvals and preserves Sites credentials', async t => {
    const f = await fixture(t);
    const approvals = await f.run(['approvals', '9'], agentCLI);
    assert.equal(approvals.code, 0, approvals.stderr); assert.equal(f.requests[0].query.approvals, '1'); assert.equal(f.requests[0].query.since, '9');
    const approved = await f.run(['approve', 'worker-ready', revision, 'Coordinator reviewed'], agentCLI);
    assert.equal(approved.code, 0, approved.stderr); const post = f.requests.find(r => r.method === 'POST');
    assert.equal(post.body.revision, revision); assert.equal(post.body.authority, 'coordinator'); assert.equal(post.headers['oai-sites-authorization'], 'Bearer mock-sites-token');
});
