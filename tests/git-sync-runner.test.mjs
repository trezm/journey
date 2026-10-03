import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { GitSyncRunner, createAPI, gitEnvironment, validateRemote, validateBranch } from '../public/git-sync.mjs';

const connection = { url: 'https://journey.example.test', project: 'project', token: 'dummy-journey-secret', siteToken: 'dummy-site-secret' };
const git = (cwd, args, input) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Original Author', '-c', 'user.email=author@example.test', ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: gitEnvironment({ allowLocal: true }), timeout: 10000 }).trim();

async function fixture(t) {
    const temp = await mkdtemp(join(tmpdir(), 'journey-sync-test-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const local = join(temp, 'local'), journey = join(temp, 'journey.git'), remote = join(temp, 'remote.git');
    await mkdir(local); git(local, ['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(local, 'shared.txt'), 'base\n'); git(local, ['add', '.']); git(local, ['commit', '--quiet', '-m', 'Base']);
    const base = git(local, ['rev-parse', 'HEAD']);
    git(temp, ['clone', '--quiet', '--bare', local, journey]); git(temp, ['clone', '--quiet', '--bare', local, remote]);
    const state = { head: base, sync: { remote, branch: 'main', enabled: true, status: 'idle', lastRemoteHead: base } };
    const actions = [], uploads = [];
    let onStage, rejectComplete = 0, loseCompleteResponse = false;
    const ref = (id, suffix) => `refs/heads/journey-sync/${id}/${suffix}`;
    const api = {
        async get() { return structuredClone(state); },
        async objects(runId, body) {
            assert.equal(state.sync.run.id, runId);
            uploads.push({ runId, bytes: body.length });
            let offset = 0;
            while (offset < body.length) {
                const expected = body.subarray(offset, offset + 40).toString('ascii'), length = body.readUInt32BE(offset + 40); offset += 44;
                const raw = inflateSync(body.subarray(offset, offset + length)); offset += length;
                const zero = raw.indexOf(0), [type, size] = raw.subarray(0, zero).toString().split(' '), bytes = raw.subarray(zero + 1);
                assert.equal(bytes.length, Number(size)); assert.equal(git(journey, ['hash-object', '-w', '-t', type, '--stdin'], bytes), expected);
            }
            assert.equal(offset, body.length);
        },
        async post(body) {
            actions.push(structuredClone(body));
            const run = state.sync.run;
            if (body.action === 'observe') {
                assert(!run); assert.equal(body.head, state.head); assert.equal(body.expectedRemote, state.sync.remote); assert.equal(body.expectedBranch, state.sync.branch);
                state.sync.lastCheckedAt = Date.now(); state.sync.lastSyncedHead = state.head; state.sync.lastRemoteHead = state.head;
            } else if (body.action === 'begin') {
                assert.equal(body.expectedHead, state.head); assert(!run);
                assert.equal(body.expectedRemote, state.sync.remote); assert.equal(body.expectedBranch, state.sync.branch);
                state.sync.run = { id: body.runId, journeyHead: state.head, remoteHead: body.remoteHead, phase: 'preparing', conflictBranch: `journey-conflicts/${body.runId}` };
                state.sync.status = 'running'; git(journey, ['update-ref', ref(body.runId, 'original'), state.head]);
            } else {
                assert.equal(run.id, body.runId);
                if (body.action === 'prepare') {
                    run.base = body.base; run.prepared = true;
                    if (run.remoteHead) git(journey, ['update-ref', ref(run.id, 'remote'), run.remoteHead]);
                } else if (body.action === 'stage') {
                    if (run.phase === 'resolving') assert.equal(body.head, run.resolutionHead);
                    else run.phase = 'publishing';
                    run.candidate = body.head; run.rewrites = body.rewrites;
                    git(journey, ['update-ref', ref(run.id, 'candidate'), body.head]);
                    if (onStage) { const callback = onStage; onStage = undefined; await callback(body); }
                } else if (body.action === 'complete') {
                    if (rejectComplete-- > 0) throw new Error('Simulated API outage after remote push');
                    assert.equal(body.head, run.candidate);
                    state.head = run.candidate; git(journey, ['update-ref', 'refs/heads/main', run.candidate]);
                    state.sync.lastRunId = run.id; state.sync.lastRemoteHead = run.candidate; state.sync.lastCompletedHead = run.candidate; state.sync.status = 'idle'; delete state.sync.run;
                    if (loseCompleteResponse) { loseCompleteResponse = false; throw new Error('Simulated lost completion response'); }
                } else if (body.action === 'conflict') {
                    run.phase = 'conflict'; run.conflicts = body.files; run.conflictReason = body.reason; state.sync.status = 'conflict';
                } else if (body.action === 'conflict_published') { run.conflictPublished = body.published; run.conflictPublishError = body.error; }
                else if (body.action === 'fail') { state.sync.status = 'error'; state.sync.error = body.error; }
                else if (body.action === 'restart') {
                    assert.notEqual(body.observedRemoteHead, run.remoteHead); assert.notEqual(body.observedRemoteHead, run.candidate);
                    git(journey, ['update-ref', ref(run.id, 'observed'), body.observedRemoteHead]); delete state.sync.run; state.sync.status = 'idle';
                } else if (body.action === 'resolve') { run.phase = 'resolving'; run.resolutionHead = body.head; delete run.candidate; }
                else throw new Error('Unexpected action ' + body.action);
            }
            return structuredClone(state.sync);
        },
    };
    async function commit(destination, filename, content, message) {
        git(local, ['fetch', '--quiet', destination, 'refs/heads/main']);
        git(local, ['checkout', '--quiet', '--detach', git(destination, ['rev-parse', 'refs/heads/main'])]);
        await writeFile(join(local, filename), content); git(local, ['add', '.']); git(local, ['commit', '--quiet', '-m', message]);
        const head = git(local, ['rev-parse', 'HEAD']); git(local, ['push', '--quiet', destination, `${head}:refs/heads/main`]);
        if (destination === journey) state.head = head;
        return head;
    }
    const runner = () => new GitSyncRunner(connection, { api, source: journey, allowLocal: true });
    return { temp, local, journey, remote, base, state, actions, uploads, api, commit, runner, onStage: callback => { onStage = callback; }, rejectNextComplete: () => { rejectComplete = 1; }, loseCompleteResponse: () => { loseCompleteResponse = true; } };
}

test('disabled and unchanged repositories do not begin runs or upload objects', async t => {
    const f = await fixture(t);
    f.state.sync.enabled = false;
    assert.equal((await f.runner().once()).status, 'disabled');
    f.state.sync.enabled = true;
    assert.equal((await f.runner().once()).status, 'idle');
    assert.equal(f.actions.length, 1); assert.equal(f.actions[0].action, 'observe'); assert.deepEqual(f.uploads, []);
    assert.equal((await f.runner().once()).status, 'idle'); assert.equal(f.actions.length, 1);
});

test('publishes Journey commits and imports incoming commits without rewriting either', async t => {
    const f = await fixture(t);
    const outgoing = await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey accepted commit');
    assert.equal((await f.runner().once()).head, outgoing);
    assert.equal(git(f.remote, ['rev-parse', 'main']), outgoing);
    const incoming = await f.commit(f.remote, 'external.txt', 'external\n', 'External Git commit');
    assert.equal((await f.runner().once()).head, incoming);
    assert.equal(f.state.head, incoming);
    assert.equal(git(f.journey, ['show', `${incoming}:external.txt`]), 'external');
    assert(f.actions.some(a => a.action === 'prepare'));
});

test('rebases a true divergence and records old-to-new SHAs while preserving authors', async t => {
    const f = await fixture(t);
    const outgoing = await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey accepted commit');
    const incoming = await f.commit(f.remote, 'external.txt', 'external\n', 'External Git commit');
    const result = await f.runner().once();
    assert.equal(result.status, 'synced'); assert.notEqual(result.head, outgoing);
    assert.equal(git(f.remote, ['rev-parse', 'main']), result.head);
    assert.equal(git(f.remote, ['rev-parse', 'main^']), incoming);
    assert.equal(git(f.remote, ['show', 'main:journey.txt']), 'accepted');
    assert.equal(git(f.remote, ['show', 'main:external.txt']), 'external');
    assert.equal(git(f.remote, ['show', '-s', '--format=%an <%ae>', 'main']), 'Original Author <author@example.test>');
    assert.equal(f.actions.find(a => a.action === 'stage').rewrites[outgoing], result.head);
    assert.equal(git(f.journey, ['cat-file', '-t', outgoing]), 'commit');
});

test('conflicts freeze the run and publish the original Journey head, then adopt an explicit resolution', async t => {
    const f = await fixture(t);
    const original = await f.commit(f.journey, 'shared.txt', 'journey change\n', 'Journey competing edit');
    const incoming = await f.commit(f.remote, 'shared.txt', 'remote change\n', 'Remote competing edit');
    const conflict = await f.runner().once();
    assert.equal(conflict.status, 'conflict'); assert(conflict.published);
    assert.equal(f.state.head, original); assert.equal(git(f.remote, ['rev-parse', 'main']), incoming);
    assert.equal(git(f.remote, ['rev-parse', `refs/heads/${conflict.conflictBranch}`]), original);
    assert.deepEqual(f.state.sync.run.conflicts, ['shared.txt']);
    assert(!f.actions.some(a => a.action === 'complete'));
    const actionCount = f.actions.length;
    assert.equal((await f.runner().once()).status, 'conflict'); assert.equal(f.actions.length, actionCount);
    const resolved = await f.commit(f.remote, 'shared.txt', 'manual resolution\n', 'Human resolution');
    await f.api.post({ action: 'resolve', runId: f.state.sync.run.id, head: resolved });
    assert.equal((await f.runner().once()).head, resolved);
    assert.equal(f.state.head, resolved); assert.equal(git(f.journey, ['show', `${resolved}:shared.txt`]), 'manual resolution');
    assert.equal(git(f.remote, ['rev-parse', `refs/heads/${conflict.conflictBranch}`]), original);
});

test('an explicit lease preserves remote advances and rebases again after a push race', async t => {
    const f = await fixture(t);
    await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey change');
    await f.commit(f.remote, 'external.txt', 'first\n', 'External change');
    const runner = f.runner(), originalGit = runner.git.bind(runner);
    let raced, attemptedLease;
    runner.git = function(args, options) {
        if (!raced && args[0] === 'push' && args.at(-1).endsWith(':refs/heads/main')) {
            attemptedLease = args.find(arg => arg.startsWith('--force-with-lease='));
            git(f.local, ['checkout', '--quiet', '--detach', git(f.remote, ['rev-parse', 'main'])]);
            execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "racing\\n")', join(f.local, 'racing.txt')]);
            git(f.local, ['add', '.']); git(f.local, ['commit', '--quiet', '-m', 'Racing remote commit']);
            raced = git(f.local, ['rev-parse', 'HEAD']); git(f.local, ['push', '--quiet', f.remote, `${raced}:refs/heads/main`]);
        }
        return originalGit(args, options);
    };
    const result = await runner.once();
    assert.match(attemptedLease, /^--force-with-lease=refs\/heads\/main:[a-f0-9]{40}$/);
    assert.equal(result.status, 'synced'); assert(f.actions.some(a => a.action === 'restart'));
    assert.equal(git(f.remote, ['rev-parse', 'main^']), raced);
    assert.equal(git(f.remote, ['show', 'main:racing.txt']), 'racing');
    assert.equal(git(f.remote, ['show', 'main:journey.txt']), 'accepted');
});

test('recovers a published candidate after the server was unavailable before completion', async t => {
    const f = await fixture(t);
    const original = await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey change');
    await f.commit(f.remote, 'external.txt', 'external\n', 'External change');
    f.rejectNextComplete();
    await assert.rejects(f.runner().once(), /Simulated API outage/);
    const candidate = f.state.sync.run.candidate;
    assert.notEqual(candidate, original); assert.equal(f.state.head, original);
    assert.equal(git(f.remote, ['rev-parse', 'main']), candidate);
    const result = await f.runner().once();
    assert.equal(result.head, candidate); assert.equal(f.state.head, candidate);
    assert.equal(f.actions.filter(a => a.action === 'begin').length, 1);
});

test('a lost completion response is recognized as a completed persisted run', async t => {
    const f = await fixture(t);
    const original = await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey change');
    f.loseCompleteResponse();
    assert.equal((await f.runner().once()).head, original);
    assert.equal(f.state.sync.status, 'idle'); assert(!f.actions.some(a => a.action === 'fail'));
});

test('an uncertain prior push followed by another remote commit does not replay an accepted patch twice', async t => {
    const f = await fixture(t);
    await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey change');
    await f.commit(f.remote, 'external.txt', 'external\n', 'External change');
    f.rejectNextComplete(); await assert.rejects(f.runner().once(), /Simulated API outage/);
    const accepted = f.state.sync.run.candidate;
    const latest = await f.commit(f.remote, 'later.txt', 'later\n', 'Remote after accepted push');
    const result = await f.runner().once();
    assert.equal(result.head, latest); assert.equal(git(f.remote, ['rev-parse', 'main^']), accepted);
    assert.equal(git(f.remote, ['rev-list', '--count', '--all', '--grep=Journey change']), '1');
    assert(f.actions.some(action => action.action === 'restart'));
});

test('configuration changes between observation and begin cannot publish to the stale target', async t => {
    const f = await fixture(t);
    const original = await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey change');
    const runner = f.runner(), originalRemoteHead = runner.remoteHead.bind(runner);
    runner.remoteHead = (...args) => { const result = originalRemoteHead(...args); f.state.sync.branch = 'other'; return result; };
    await assert.rejects(runner.once());
    assert.equal(git(f.remote, ['rev-parse', 'main']), f.base); assert.equal(f.state.head, original); assert(!f.state.sync.run);
});

test('equal-head observation also checks the exact configured target', async t => {
    const f = await fixture(t), runner = f.runner(), originalRemoteHead = runner.remoteHead.bind(runner);
    runner.remoteHead = (...args) => { const result = originalRemoteHead(...args); f.state.sync.branch = 'other'; return result; };
    await assert.rejects(runner.once()); assert.equal(f.state.sync.lastCheckedAt, undefined);
});

test('a resumed resolution must still match the exact remote head selected by the owner', async t => {
    const f = await fixture(t);
    await f.commit(f.journey, 'shared.txt', 'journey change\n', 'Journey competing edit');
    const incoming = await f.commit(f.remote, 'shared.txt', 'remote change\n', 'Remote competing edit');
    await f.runner().once();
    await f.api.post({ action: 'resolve', runId: f.state.sync.run.id, head: incoming });
    const newer = await f.commit(f.remote, 'shared.txt', 'manual resolution\n', 'Later remote edit');
    await assert.rejects(f.runner().once(), /moved after the selected resolution/);
    assert.equal(git(f.remote, ['rev-parse', 'main']), newer); assert(f.state.sync.run);
    await f.api.post({ action: 'resolve', runId: f.state.sync.run.id, head: newer });
    assert.equal((await f.runner().once()).head, newer);
});

test('a remote advance during resolution upload and staging keeps the repository paused', async t => {
    const f = await fixture(t);
    const original = await f.commit(f.journey, 'shared.txt', 'journey change\n', 'Journey competing edit');
    const incoming = await f.commit(f.remote, 'shared.txt', 'remote change\n', 'Remote competing edit');
    await f.runner().once();
    await f.api.post({ action: 'resolve', runId: f.state.sync.run.id, head: incoming });
    let newer;
    f.onStage(async () => { newer = await f.commit(f.remote, 'shared.txt', 'newer resolution\n', 'Remote moved during upload'); });
    await assert.rejects(f.runner().once(), /moved while importing/);
    assert.equal(f.state.head, original); assert(!f.actions.some(action => action.action === 'complete'));
    await f.api.post({ action: 'resolve', runId: f.state.sync.run.id, head: newer });
    assert.equal((await f.runner().once()).head, newer);
});

test('recovers a run interrupted before remote objects were uploaded', async t => {
    const f = await fixture(t);
    await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey change');
    const incoming = await f.commit(f.remote, 'external.txt', 'external\n', 'External change');
    await f.api.post({ action: 'begin', runId: 'interrupted-run', expectedHead: f.state.head, remoteHead: incoming, expectedRemote: f.remote, expectedBranch: 'main' });
    assert.equal((await f.runner().once()).status, 'synced');
    assert.equal(f.actions.filter(a => a.action === 'begin').length, 1);
});

test('never overwrites a conflict branch collision', async t => {
    const f = await fixture(t);
    const original = await f.commit(f.journey, 'shared.txt', 'journey\n', 'Journey change');
    const incoming = await f.commit(f.remote, 'shared.txt', 'remote\n', 'Remote change');
    const runner = f.runner(), originalPublish = runner.publishConflict.bind(runner);
    runner.publishConflict = run => { git(f.remote, ['update-ref', 'refs/heads/' + run.conflictBranch, incoming]); return originalPublish(run); };
    const result = await runner.once();
    assert.equal(result.status, 'conflict'); assert.equal(result.published, false);
    assert.match(result.error, /already exists/);
    assert.equal(git(f.remote, ['rev-parse', result.conflictBranch]), incoming); assert.equal(f.state.head, original);
});

test('unrelated histories pause for explicit manual resolution instead of synthesizing ancestry', async t => {
    const f = await fixture(t);
    git(f.local, ['checkout', '--quiet', '--orphan', 'unrelated']);
    git(f.local, ['rm', '--quiet', '-rf', '.']); await writeFile(join(f.local, 'other.txt'), 'other\n');
    git(f.local, ['add', '.']); git(f.local, ['commit', '--quiet', '-m', 'Unrelated root']);
    const unrelated = git(f.local, ['rev-parse', 'HEAD']); git(f.local, ['push', '--quiet', '--force', f.remote, `${unrelated}:refs/heads/main`]);
    const result = await f.runner().once();
    assert.equal(result.status, 'conflict'); assert.equal(f.state.sync.run.conflictReason, 'unrelated_histories');
    assert.equal(git(f.remote, ['rev-parse', 'main']), unrelated); assert.equal(f.state.head, f.base);
});

test('rebase execution failures without unmerged files become retryable errors, not conflicts', async t => {
    const f = await fixture(t);
    await f.commit(f.journey, 'journey.txt', 'accepted\n', 'Journey change');
    await f.commit(f.remote, 'external.txt', 'external\n', 'External change');
    const runner = f.runner(), originalGit = runner.git.bind(runner);
    runner.git = (args, options) => args[0] === 'rebase' ? { status: 128 } : originalGit(args, options);
    await assert.rejects(runner.once(), /Git rebase failed/);
    assert.equal(f.state.sync.status, 'error'); assert(!f.actions.some(a => a.action === 'conflict'));
});

test('credentials are origin-scoped, isolated by transport, and inherited Git settings are removed', async t => {
    const f = await fixture(t);
    const runner = new GitSyncRunner(connection, { api: f.api, env: { ...process.env, AVC_TOKEN: connection.token, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://evil.test/.insteadOf', GIT_CONFIG_VALUE_0: 'https:', GIT_TRACE: '/tmp/never-written', GIT_SYNC_REMOTE_TOKEN: 'dummy-remote-secret', GIT_SYNC_REMOTE_URL: 'https://git.example.test/team/repo.git' } });
    await runner.workspace({ remote: 'https://git.example.test/team/repo.git', branch: 'main' });
    t.after(() => rm(runner.temp, { recursive: true, force: true }));
    const journeyConfig = runner.git(['config', '--list']);
    assert(journeyConfig.includes(`http.${runner.source}.extraheader=Authorization: Basic ${Buffer.from('journey:' + connection.token).toString('base64')}`));
    assert(!journeyConfig.includes('dummy-remote-secret'));
    const remoteConfig = runner.git(['config', '--list'], { remote: true });
    assert(!remoteConfig.includes(Buffer.from('journey:' + connection.token).toString('base64')));
    assert(!remoteConfig.includes(connection.siteToken)); assert(!remoteConfig.includes('evil.test'));
    assert(remoteConfig.includes(`http.https://git.example.test/team/repo.git.extraheader=Authorization: Basic ${Buffer.from('x-access-token:dummy-remote-secret').toString('base64')}`));
    const env = gitEnvironment({ base: { PATH: process.env.PATH, GIT_TRACE: 'danger', GIT_SSH_COMMAND: 'danger', GIT_CONFIG_COUNT: '9', AVC_TOKEN: 'secret' } });
    assert.equal(env.GIT_TRACE, undefined); assert.equal(env.GIT_SSH_COMMAND, undefined); assert.equal(env.AVC_TOKEN, undefined); assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    runner.remote = 'https://different.example.test/team/repo.git';
    assert.throws(() => runner.git(['config', '--list'], { remote: true }), /exactly match the configured remote/);
});

test('the coordinator API uses only its configured origin and refuses redirects', async () => {
    const requests = [];
    const api = createAPI(connection, async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ result: { ok: true } })); });
    await api.get(); await api.post({ action: 'complete', runId: 'test-run', head: 'a'.repeat(40) });
    for (const { url, options } of requests) {
        assert.equal(new URL(url).origin, connection.url); assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer ' + connection.token);
    }
});

test('remote and branch validation prevent option injection and credential URLs', () => {
    for (const value of ['https://secret@example.test/repo', 'https://example.test/repo?token=secret', 'file:///tmp/repo', '/tmp/repo', 'ext::sh -c evil', '-u@example.test:repo', 'https://example.test/repo\nextra']) assert.throws(() => validateRemote(value));
    for (const value of ['--upload-pack=evil', 'main:other', 'main..branch', 'x.lock', 'a//b', '.hidden']) assert.throws(() => validateBranch(value));
    assert.equal(validateRemote('git@example.test:team/repo.git'), 'git@example.test:team/repo.git');
    assert.equal(validateRemote('ssh://git@example.test/team/repo.git'), 'ssh://git@example.test/team/repo.git');
});
