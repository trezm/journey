import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicCLI = fileURLToPath(new URL('../public/journey.mjs', import.meta.url));
const agentCLI = fileURLToPath(new URL('../cli/agent.mjs', import.meta.url));
const project = '12345678-1234-1234-1234-123456789012', journey = 'posted-worker';
const revision = 'a'.repeat(40), canonical = 'b'.repeat(40);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const lease = (token, changes = {}) => ({ token, journey, expires: Date.now() + 600000, ...changes });

async function fixture(t, leases, changes = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'journey-posted-locks-cli-'));
    await mkdir(join(directory, '.journey'));
    const requests = [], children = [];
    const context = {
        state: { journeys: [{ id: journey, head: revision, status: 'review', posted: true }], leases, waiting: [], head: canonical, integrationCursor: 2, ...changes },
        cursor: 1, events: [{ id: 1, type: 'review.requested', journey }],
    };
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            let body = ''; for await (const chunk of req) body += chunk;
            const request = { method: req.method, query: Object.fromEntries(url.searchParams), ...(body ? { body: JSON.parse(body) } : {}) };
            requests.push(request);
            const result = req.method === 'POST' ? { result: { ok: true } } : url.searchParams.has('journey')
                ? { cursor: context.cursor, events: context.events.filter(e => e.id > Number(url.searchParams.get('since'))) }
                : { state: context.state };
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port, profile = join(directory, 'connection.json');
    await writeFile(profile, JSON.stringify({ url, project, token: 'mock-worker-token' }));
    await writeFile(join(directory, '.journey/config.json'), JSON.stringify({ connection: profile, journey }));
    const env = { ...process.env, JOURNEY_CONNECTION: profile, JOURNEY_CONFIG_HOME: join(directory, 'credentials'), AVC_URL: url, AVC_PROJECT: project, AVC_TOKEN: 'mock-worker-token' };
    function launch(args, cli = publicCLI) {
        const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
        let stdout = '', stderr = '';
        child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
        const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
        return { child, completion };
    }
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
    });
    return { directory, context, requests, launch, run: (args, cli) => launch(args, cli).completion };
}

async function until(check, ms = 12000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await check()) return; await pause(40); }
    throw new Error('Timed out waiting for worker watcher.');
}

test('worker watcher renews only current draft locks while retaining inbox monitoring', { timeout: 20000 }, async t => {
    const f = await fixture(t, [lease('draft'), lease('retained', { retained: true, expires: 0 }), lease('expired', { expires: 0 }), lease('foreign', { journey: 'other-worker' })], {
        journeys: [{ id: journey, head: revision, status: 'working' }],
    });
    const watching = f.launch(['watch']);
    await until(async () => (await readFile(join(f.directory, '.journey/cursor'), 'utf8').catch(() => '')) === '1');
    const renewals = f.requests.filter(r => r.method === 'POST');
    assert.equal(renewals.length, 1); assert.equal(renewals[0].body.action, 'refresh'); assert.deepEqual(renewals[0].body.tokens, ['draft']);
    // Posting changes the lease lifetime, while an adapted revision may still be in progress.
    f.context.state.journeys[0].posted = true;
    f.context.state.leases[0] = lease('draft', { retained: true, expires: 0 });
    f.context.cursor = 2; f.context.events.push({ id: 2, type: 'journey.integrated', journey: 'other-worker' });
    await until(async () => (await readFile(join(f.directory, '.journey/cursor'), 'utf8').catch(() => '')) === '2');
    await until(async () => /2 locks \(2 retained\)/.test(await readFile(join(f.directory, '.journey/watcher.log'), 'utf8').catch(() => '')));
    watching.child.kill('SIGTERM'); await watching.completion;
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
    const events = (await readFile(join(f.directory, '.journey/inbox.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e => e.id), [1, 2]);
    assert.match(await readFile(join(f.directory, '.journey/watcher.log'), 'utf8'), /2 locks \(2 retained\)/);
});

test('posted watcher makes no renewal requests and keeps reading reviews until closure', { timeout: 20000 }, async t => {
    const f = await fixture(t, [lease('retained', { retained: true, expires: 0 })]);
    const watching = f.launch(['watch']);
    await until(async () => (await readFile(join(f.directory, '.journey/cursor'), 'utf8').catch(() => '')) === '1');
    f.context.cursor = 2; f.context.events.push({ id: 2, type: 'review.request_changes', journey });
    f.context.state.journeys[0].status = 'working';
    await until(async () => (await readFile(join(f.directory, '.journey/cursor'), 'utf8').catch(() => '')) === '2');
    f.context.state.journeys[0].status = 'abandoned';
    const result = await watching.completion;
    assert.equal(result.code, 0, result.stderr);
    assert(f.requests.every(r => r.method === 'GET'));
    assert.deepEqual((await readFile(join(f.directory, '.journey/inbox.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).map(e => e.id), [1, 2]);
    assert(!f.requests.some(r => r.query?.approvals));
});

test('integration returns retained tokens independently of their compatibility expiry value', async t => {
    const f = await fixture(t, [lease('retained', { retained: true, expires: 0 }), lease('draft'), lease('expired', { expires: 0 }), lease('foreign', { journey: 'other-worker', retained: true })]);
    const result = await f.run(['integrate']);
    assert.equal(result.code, 0, result.stderr);
    const request = f.requests.find(r => r.method === 'POST').body;
    assert.equal(request.action, 'integrate'); assert.equal(request.journey, journey);
    assert.equal(request.revision, revision); assert.equal(request.head, canonical); assert.equal(request.cursor, 2);
    assert.deepEqual(request.tokens, ['retained', 'draft']);
});

test('standalone keepalive exits without renewal when all current locks are retained', async t => {
    const f = await fixture(t, [lease('retained', { retained: true, expires: 0 }), lease('expired', { expires: 0 })]);
    const result = await f.run(['keepalive', journey], agentCLI);
    assert.equal(result.code, 0, result.stderr);
    const message = JSON.parse(result.stdout);
    assert.equal(message.retained, 1); assert.match(message.message, /until integration or abandonment/); assert.match(message.message, /poll/);
    assert(f.requests.every(r => r.method === 'GET'));
});

test('standalone keepalive renews drafts without sending retained or expired tokens', async t => {
    const f = await fixture(t, [lease('draft'), lease('retained', { retained: true, expires: 0 }), lease('expired', { expires: 0 })]);
    const running = f.launch(['keepalive', journey], agentCLI);
    await until(() => f.requests.some(r => r.method === 'POST'));
    running.child.kill('SIGTERM'); await running.completion;
    const request = f.requests.find(r => r.method === 'POST').body;
    assert.equal(request.action, 'refresh'); assert.deepEqual(request.tokens, ['draft']);
});

test('generated agent instructions distinguish posting, draft expiry and sync invalidation', async t => {
    const f = await fixture(t, []);
    execFileSync('git', ['init', '--quiet', f.directory]);
    const result = await f.run(['setup', f.directory]);
    assert.equal(result.code, 0, result.stderr);
    const instructions = await readFile(join(f.directory, '.journey/AGENTS.md'), 'utf8');
    assert.match(instructions, /Submitting for review officially posts the journey/);
    assert.match(instructions, /Published patches alone do not post it/);
    assert.match(instructions, /draft locks expire after 10 minutes without renewal/);
    assert.match(instructions, /Retained locks are released when the journey integrates or is abandoned, or invalidated by overlapping external Git sync changes/);
    assert.match(instructions, /wait for synchronization to finish, reconcile the new main, then reacquire missing scopes/);
    assert.match(instructions, /posting never revives expired tokens/);
    assert.match(instructions, /watcher still monitors reviews and integrations after posting/);
    const protocol = await f.run(['protocol']);
    assert.equal(protocol.stdout, instructions + '\n');
});
