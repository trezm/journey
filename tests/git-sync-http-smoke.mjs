// Run against a LOCAL built Worker. All Git remotes are disposable local bare repositories.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSyncRunner } from '../public/git-sync.mjs';

const root = process.env.AVC_TEST_URL ?? 'http://127.0.0.1:4173';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(root).hostname), 'This test only runs against a local Worker.');
let cookie = '';
async function request(path, body, token, status = 200) {
    const response = await fetch(root + path, {
        method: body ? 'POST' : 'GET',
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify({ error: result.error, code: result.code }));
    return result.result ?? result;
}
const directory = await mkdtemp(join(tmpdir(), 'journey-sync-http-'));
const remote = join(directory, 'remote.git'), working = join(directory, 'working');
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete gitEnv[key];
delete gitEnv.GIT_CONFIG_COUNT;
function git(args, cwd = directory, extraEnv = {}) {
    return execFileSync('git', ['-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...gitEnv, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
}
try {
    await request('/api/auth', { action: 'register', username: 'test-' + crypto.randomUUID().slice(0, 24), email: `sync-${crypto.randomUUID()}@example.test`, password: 'local-sync-fixture-password' });
    const { project } = await request('/api/avc', { action: 'create_project', name: 'Git synchronization smoke', files: { 'file.txt': 'one\ntwo\nthree\n', 'other.txt': 'base\n' } });
    const act = (action, body = {}, token, status) => request('/api/avc', { action, project, requestId: crypto.randomUUID(), ...body }, token, status);
    const state = async () => (await request('/api/avc?project=' + project)).state;
    const coordinator = await act('create_agent', { name: 'Sync runner', coordinator: true });
    const worker = await act('create_agent', { name: 'Active worker' });
    const sync = (action, body = {}, token = coordinator.token, status) => request('/api/sync', { project, action, ...body }, token, status);
    const configuredRemote = 'https://sync-fixture.invalid/repository.git';
    await sync('configure', { remote: configuredRemote, branch: 'main', enabled: true }, worker.token, 403);
    await request('/api/sync', { project, action: 'configure', remote: 'https://token@example.test/repo.git', branch: 'main', enabled: true }, undefined, 400);
    await request('/api/sync', { project, action: 'configure', remote: configuredRemote, branch: 'main', enabled: true });
    git(['clone', '--bare', '--quiet', root + '/api/git/' + project + '/', remote], directory, {
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Bearer ' + coordinator.token,
    });
    git(['clone', '--quiet', remote, working]);

    // Only the transport is substituted: runner state, HTTP API, storage, Git
    // object ingestion, native rebase and conflict publication are all real.
    const runner = new GitSyncRunner({ url: root, project, token: coordinator.token }, { allowLocal: true });
    const nativeGit = runner.git.bind(runner);
    runner.git = (args, options) => nativeGit(args.map(arg => arg === configuredRemote ? remote : arg), options);
    assert.equal((await runner.once()).status, 'idle');

    async function patch(path, content, title, post = true) {
        const { journey } = await act('create_journey', { title }, worker.token);
        const { changeset } = await act('create_changeset', { journey, description: title }, worker.token);
        const revision = (await state()).head;
        const grant = await act('acquire', { journey, changeset, revision, scopes: [{ path, start: 1, end: 1, whole: true }] }, worker.token);
        const tokens = grant.locks.map(lock => lock.token);
        const result = await act('patch', { journey, changeset, revision, tokens, description: title, edits: [{ path, content }] }, worker.token);
        if (post) {
            await act('declare_breaking', { journey, changes: [] }, worker.token);
            await act('submit', { journey, revision: result.revision, tokens }, worker.token);
        }
        return { journey, revision: result.revision, tokens };
    }
    async function integrate(path, content, title) {
        const candidate = await patch(path, content, title);
        await act('review', { journey: candidate.journey, revision: candidate.revision, kind: 'approve', body: 'Local test reviewed' });
        const before = await state();
        return act('integrate', { ...candidate, head: before.head, cursor: before.integrationCursor }, worker.token);
    }
    const active = await patch('file.txt', 'one\nworker edit\nthree\n', 'Work held across sync');
    assert((await state()).leases.some(lock => lock.journey === active.journey && lock.retained));
    await writeFile(join(working, 'file.txt'), 'one\nexternal edit\nthree\n');
    await writeFile(join(working, 'binary.bin'), Buffer.from([0, 3, 9]));
    git(['add', '.'], working); git(['commit', '--quiet', '-m', 'Incoming external changes'], working); git(['push', '--quiet', 'origin', 'main'], working);
    const external = git(['rev-parse', 'main'], remote);
    const imported = await runner.once();
    assert.equal(imported.status, 'synced');
    assert.equal((await state()).head, external);
    const afterImport = await state();
    assert(!afterImport.leases.some(lock => lock.journey === active.journey));
    assert.equal(afterImport.journeys.find(journey => journey.id === active.journey).head, active.revision);
    assert(afterImport.events.some(event => event.type === 'lock.invalidated' && event.journey === active.journey));
    assert(afterImport.events.some(event => event.type === 'repository.synced'));

    const accepted = await integrate('other.txt', 'journey accepted\n', 'Accepted local work');
    await writeFile(join(working, 'remote.txt'), 'remote independent\n');
    git(['add', '.'], working); git(['commit', '--quiet', '-m', 'Remote diverges'], working); git(['push', '--quiet', 'origin', 'main'], working);
    const beforeRebase = git(['rev-parse', 'main'], remote);
    const rebased = await runner.once();
    assert.equal(rebased.status, 'synced');
    const rebasedState = await state();
    assert.equal(rebasedState.head, git(['rev-parse', 'main'], remote));
    assert.notEqual(rebasedState.head, accepted.revision);
    assert.equal(git(['show', 'main:other.txt'], remote), 'journey accepted');
    assert.equal(git(['show', 'main:remote.txt'], remote), 'remote independent');
    git(['merge-base', '--is-ancestor', beforeRebase, rebasedState.head], remote);
    const refs = await fetch(root + '/api/git/' + project + '/info/refs', { headers: { Authorization: 'Bearer ' + coordinator.token } }).then(response => response.text());
    assert(refs.includes(accepted.revision + '\trefs/heads/journey-sync/'));

    // Manufacture a real Git rebase conflict and verify freeze/export/resume.
    git(['fetch', '--quiet', 'origin'], working); git(['reset', '--hard', 'origin/main'], working);
    const journeyConflict = await integrate('other.txt', 'Journey conflict\n', 'Conflicting Journey commit');
    await writeFile(join(working, 'other.txt'), 'Remote conflict\n');
    git(['add', '.'], working); git(['commit', '--quiet', '-m', 'Conflicting remote commit'], working); git(['push', '--quiet', 'origin', 'main'], working);
    const remoteConflict = git(['rev-parse', 'main'], remote);
    const conflict = await runner.once();
    assert.equal(conflict.status, 'conflict');
    const paused = await state(), run = paused.sync.run;
    assert.equal(paused.head, journeyConflict.revision);
    assert.equal(run.journeyHead, journeyConflict.revision);
    assert.equal(run.remoteHead, remoteConflict);
    assert.equal(run.conflictPublished, true);
    assert.equal(git(['rev-parse', 'refs/heads/' + run.conflictBranch], remote), journeyConflict.revision);
    await act('create_journey', { title: 'Must wait' }, worker.token, 409);
    await sync('resolve', { runId: run.id, head: remoteConflict }, coordinator.token, 403);

    // The user may deliberately squash/cherry-pick the resolution: adoption
    // must not require the old Journey SHA to be an ancestor or replay it.
    await writeFile(join(working, 'other.txt'), 'Resolved both sides\n');
    git(['add', '.'], working); git(['commit', '--quiet', '-m', 'Manual conflict resolution'], working); git(['push', '--quiet', 'origin', 'main'], working);
    const resolved = git(['rev-parse', 'main'], remote);
    await request('/api/sync', { project, action: 'resolve', runId: run.id, head: resolved });
    assert.equal((await runner.once()).status, 'synced');
    const final = await state();
    assert.equal(final.head, resolved); assert.equal(final.sync.status, 'idle'); assert.equal(final.sync.run, undefined);
    assert.equal(git(['rev-parse', 'refs/heads/' + run.conflictBranch], remote), journeyConflict.revision);
    await act('create_journey', { title: 'Work resumes' }, worker.token);
    assert.equal((await runner.once()).status, 'idle');
    git(['fsck', '--no-dangling'], remote);
    assert.deepEqual([...await readFile(join(working, 'binary.bin'))], [0, 3, 9]);
    console.log('Git sync HTTP smoke passed: owner controls, real object upload, retained-lock invalidation, native divergence rebase, conflict branch, write pause, manual resolution adoption and preserved Git history.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
