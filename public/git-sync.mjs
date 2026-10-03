#!/usr/bin/env node
// Journey Git synchronization. Download this file and run with Node.js 22+ and Git.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const OID = /^[a-f0-9]{40}$/;
const MAX_BUFFER = 64 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const oid = value => { assert(OID.test(value ?? ''), 'Expected a complete SHA-1 commit ID.'); return value; };

export function validateRemote(remote, allowLocal = false) {
    assert(typeof remote === 'string' && remote.length <= 2048 && !/[\x00-\x20\x7f]/.test(remote), 'Use a credential-free HTTPS or SSH Git remote.');
    if (allowLocal && remote.startsWith('/')) return remote; // In-process local Git test harness only; never exposed by CLI.
    if (/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*:[a-zA-Z0-9_./~-]+$/.test(remote)) return remote;
    let url; try { url = new URL(remote); } catch { throw new Error('Use a credential-free HTTPS or SSH Git remote.'); }
    assert(['https:', 'ssh:'].includes(url.protocol) && url.hostname && !url.password && !url.search && !url.hash && (url.protocol === 'ssh:' || !url.username), 'Use a credential-free HTTPS or SSH Git remote.');
    assert(url.pathname !== '/' && !url.hostname.startsWith('-') && (!url.username || /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(url.username)), 'The Git remote must specify a repository and a valid SSH username.');
    return remote;
}

export function validateBranch(branch) {
    assert(typeof branch === 'string' && branch.length <= 255 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) && !branch.includes('..') && !branch.includes('@{') && !branch.includes('//') && !branch.startsWith('-') && branch !== '@' && branch.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock')), 'Invalid remote branch name.');
    return branch;
}

function cleanEnvironment(base) {
    // Never inherit Git redirects, HTTP headers, hook paths, tracing or alternate object stores.
    return Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('JOURNEY_') && !['AVC_TOKEN', 'AVC_SITE_SERVICE_TOKEN'].includes(key)));
}

export function gitEnvironment({ base = process.env, config = [], allowLocal = false, allowHTTP = false } = {}) {
    const env = { ...cleanEnvironment(base), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(config.length), GIT_ALLOW_PROTOCOL: 'https:ssh' + (allowLocal ? ':file' : '') + (allowHTTP ? ':http' : '') };
    config.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
    return env;
}

function credentialConfig(remote, base) {
    if (!remote.startsWith('https:')) return [];
    // Keep the user's credential helper, but never load global URL rewrites, filters or hooks.
    let output;
    try { output = execFileSync('git', ['config', '--get-urlmatch', 'credential', remote], { cwd: tmpdir(), env: cleanEnvironment(base), encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { if (error.status === 1) return []; throw new Error('Could not read local Git credential configuration.'); }
    return output.trim().split('\n').filter(Boolean).flatMap(line => {
        const match = /^(credential\.(?:helper|username|usehttppath)) (.*)$/i.exec(line);
        return match ? [[match[1], match[2]]] : [];
    });
}

function connectionURL(connection) {
    let url; try { url = new URL(connection.url); } catch { throw new Error('Invalid Journey connection URL.'); }
    assert((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) && !url.username && !url.password && !url.search && !url.hash, 'Journey connections require HTTPS (or HTTP localhost).');
    assert(typeof connection.project === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(connection.project) && typeof connection.token === 'string' && connection.token && !/[\r\n]/.test(connection.token), 'Invalid Journey connection.');
    assert(!connection.siteToken || (typeof connection.siteToken === 'string' && !/[\r\n]/.test(connection.siteToken)), 'Invalid Journey site credential.');
    return url.toString().replace(/\/$/, '');
}

export function createAPI(connection, fetcher = fetch) {
    const base = connectionURL(connection);
    async function request(path, body) {
        const headers = { Authorization: `Bearer ${connection.token}`, ...(connection.siteToken ? { 'OAI-Sites-Authorization': `Bearer ${connection.siteToken}` } : {}), ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) };
        for (let attempt = 0; attempt < 3; attempt++) {
            let response;
            try { response = await fetcher(base + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) }); }
            catch { if (attempt < 2) { await sleep(300 * (attempt + 1)); continue; } throw new Error('Journey request failed; the saved synchronization run can be retried.'); }
            if (response.status >= 500 && attempt < 2) { await response.arrayBuffer(); await sleep(300 * (attempt + 1)); continue; }
            let data; try { data = await response.json(); } catch { throw new Error(`Journey returned HTTP ${response.status}.`); }
            if (!response.ok) {
                // Server error details can contain remote text. Keep the terminal and persistent errors credential-free.
                const code = /^[a-z_]+$/.test(data.code ?? '') ? data.code : String(response.status);
                throw new Error(`Journey rejected synchronization (${code}); inspect repository Settings.`);
            }
            return data.result ?? data;
        }
    }
    return {
        get: () => request('/api/sync?' + new URLSearchParams({ project: connection.project })),
        post: body => request('/api/sync', JSON.stringify({ project: connection.project, requestId: randomUUID(), ...body })),
        objects: (runId, body) => request('/api/sync?' + new URLSearchParams({ project: connection.project, op: 'objects', run: runId }), body),
    };
}

class GitCommandError extends Error {
    constructor(operation, status) { super(`Git ${operation} failed${Number.isInteger(status) ? ` (exit ${status})` : ' or timed out'}. Check local Git access and repository Settings.`); this.status = status; }
}

export class GitSyncRunner {
    constructor(connection, options = {}) {
        this.connection = connection;
        this.source = options.source ?? connectionURL(connection) + '/api/git/' + connection.project + '/';
        this.api = options.api ?? createAPI(connection);
        this.baseEnv = options.env ?? process.env;
        this.allowLocal = options.allowLocal ?? false;
        this.commandTimeout = options.commandTimeout ?? 120000;
    }
    git(args, { remote = false, input, encoding = 'utf8', allowFailure = false, rewrite = false } = {}) {
        const config = [
            ['core.hooksPath', rewrite ? this.hooks : this.emptyHooks], ['core.attributesFile', '/dev/null'], ['core.fsmonitor', 'false'],
            ['http.extraHeader', ''], ['http.followRedirects', 'false'], ['protocol.ext.allow', 'never'], ['protocol.file.allow', this.allowLocal ? 'always' : 'never'],
            ['submodule.recurse', 'false'], ['fetch.recurseSubmodules', 'false'], ['maintenance.auto', 'false'], ['gc.auto', '0'], ['fetch.fsckObjects', 'true'],
            ['transfer.fsckObjects', 'true'], ['commit.gpgSign', 'false'], ['rebase.autoStash', 'false'], ['rebase.autoSquash', 'false'], ['rebase.updateRefs', 'false'],
            ['user.name', 'Journey Git Sync'], ['user.email', 'git-sync@journey.local'],
            ['credential.helper', ''], ...(remote ? this.credentials : []),
        ];
        if (!remote && /^https?:/.test(this.source)) {
            config.push([`http.${this.source}.extraHeader`, 'Authorization: Basic ' + Buffer.from('journey:' + this.connection.token).toString('base64')]);
            if (this.connection.siteToken) config.push([`http.${this.source}.extraHeader`, 'OAI-Sites-Authorization: Bearer ' + this.connection.siteToken]);
        }
        if (remote && this.baseEnv.GIT_SYNC_REMOTE_TOKEN) {
            assert(this.remote.startsWith('https:'), 'GIT_SYNC_REMOTE_TOKEN requires an HTTPS remote.');
            assert(this.baseEnv.GIT_SYNC_REMOTE_URL === this.remote, 'GIT_SYNC_REMOTE_URL must exactly match the configured remote before its token can be used.');
            assert(!/[\r\n]/.test(this.baseEnv.GIT_SYNC_REMOTE_TOKEN), 'Invalid remote credential.');
            const username = this.baseEnv.GIT_SYNC_REMOTE_USERNAME || 'x-access-token';
            assert(!/[:\r\n]/.test(username), 'Invalid remote credential username.');
            config.push([`http.${this.remote}.extraHeader`, 'Authorization: Basic ' + Buffer.from(username + ':' + this.baseEnv.GIT_SYNC_REMOTE_TOKEN).toString('base64')]);
        }
        const env = gitEnvironment({ base: this.baseEnv, config, allowLocal: this.allowLocal, allowHTTP: !remote && this.source.startsWith('http:') });
        // Dedicated credentials are consumed only above and are never passed to Git's child processes.
        delete env.GIT_SYNC_REMOTE_TOKEN; delete env.GIT_SYNC_REMOTE_USERNAME;
        env.GIT_EDITOR = 'true'; env.GIT_SEQUENCE_EDITOR = 'true';
        if (rewrite) env.JOURNEY_REWRITE_FILE = this.rewriteFile;
        try { return execFileSync('git', ['-C', this.repo, ...args], { env, input, encoding, timeout: this.commandTimeout, maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (error) { if (allowFailure && Number.isInteger(error.status)) return { status: error.status }; throw new GitCommandError(args[0], error.status); }
    }
    async workspace(sync) {
        this.remote = validateRemote(sync.remote, this.allowLocal); this.branch = validateBranch(sync.branch);
        this.credentials = credentialConfig(this.remote, this.baseEnv);
        this.temp = await mkdtemp(join(tmpdir(), 'journey-git-sync-'));
        this.repo = join(this.temp, 'repo'); this.emptyHooks = join(this.temp, 'no-hooks'); this.hooks = join(this.temp, 'hooks'); this.rewriteFile = join(this.temp, 'rewrites');
        await Promise.all([mkdir(this.repo), mkdir(this.emptyHooks), mkdir(this.hooks)]);
        await writeFile(join(this.hooks, 'post-rewrite'), '#!/bin/sh\nexec cat >> "$JOURNEY_REWRITE_FILE"\n', { mode: 0o700 });
        this.git(['init', '--quiet', '--template=', '--initial-branch=main']);
    }
    remoteHead(branch = this.branch) {
        const ref = 'refs/heads/' + validateBranch(branch);
        const output = this.git(['ls-remote', '--exit-code', '--heads', '--', this.remote, ref], { remote: true, allowFailure: true });
        if (typeof output !== 'string') { if (output.status === 2) return null; throw new GitCommandError('ls-remote', output.status); }
        const rows = output.trim().split('\n').filter(Boolean).map(row => row.split(/\s+/));
        assert(rows.length === 1 && rows[0][1] === ref, 'The Git remote returned an unexpected branch reference.');
        return oid(rows[0][0]);
    }
    fetchJourney(run) {
        const specs = ['+refs/heads/main:refs/journey/main'];
        if (run) {
            assert(/^[a-zA-Z0-9_-]{8,80}$/.test(run.id), 'Invalid saved synchronization run.');
            specs.push(`+refs/heads/journey-sync/${run.id}/original:refs/journey/original`);
            if (run.candidate) specs.push(`+refs/heads/journey-sync/${run.id}/candidate:refs/journey/candidate`);
            if (run.remoteHead && run.prepared) specs.push(`+refs/heads/journey-sync/${run.id}/remote:refs/journey/remote`);
        }
        this.git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', this.source, ...specs]);
    }
    fetchRemote() {
        if (!this.remoteHead()) return null;
        this.git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', this.remote, `+refs/heads/${this.branch}:refs/remote/main`], { remote: true });
        return oid(this.git(['rev-parse', 'refs/remote/main']).trim());
    }
    ancestor(a, b) {
        const result = this.git(['merge-base', '--is-ancestor', oid(a), oid(b)], { allowFailure: true });
        if (typeof result === 'string') return true;
        if (result.status === 1) return false;
        throw new GitCommandError('merge-base', result.status);
    }
    commonBase(a, b) {
        if (!b) return null;
        const result = this.git(['merge-base', oid(a), oid(b)], { allowFailure: true });
        if (typeof result === 'string') return oid(result.trim());
        if (result.status === 1) return null;
        throw new GitCommandError('merge-base', result.status);
    }
    async upload(runId, head, known = []) {
        if (!head) return;
        const output = this.git(['rev-list', '--objects', '--no-object-names', oid(head), ...known.filter(Boolean).map(value => '^' + oid(value))]);
        const ids = [...new Set(output.trim().split('\n').filter(Boolean))];
        assert(ids.length <= 50000, 'Synchronization limit: 50,000 new Git objects per transfer.');
        if (!ids.length) return;
        const objects = this.git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: ids.join('\n') + '\n' }).trim().split('\n').map(line => line.split(' '));
        assert(objects.every(([id, type, size]) => OID.test(id) && ['commit', 'tree', 'blob', 'tag'].includes(type) && Number(size) < 19_999_000), 'Synchronization limit: every Git object must be smaller than 20 MB.');
        assert(objects.reduce((total, [, , size]) => total + Number(size), 0) <= 300_000_000, 'Synchronization limit: 300 MB of new uncompressed Git objects.');
        let frames = [], size = 0;
        const flush = async () => { if (!frames.length) return; await this.api.objects(runId, Buffer.concat(frames)); frames = []; size = 0; };
        for (const [id, type] of objects) {
            const body = this.git(['cat-file', type, id], { encoding: null });
            const compressed = deflateSync(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));
            const header = Buffer.alloc(44); header.write(id, 0, 'ascii'); header.writeUInt32BE(compressed.length, 40);
            if (frames.length >= 128 || size + 44 + compressed.length > 6_000_000) await flush();
            frames.push(Buffer.concat([header, compressed])); size += 44 + compressed.length;
        }
        await flush();
    }
    async publishConflict(run) {
        let published = false, error;
        try {
            const prior = this.remoteHead(run.conflictBranch);
            if (prior === run.journeyHead) published = true;
            else {
                assert(!prior, 'The conflict branch already exists at a different commit. It was preserved; resolve or rename it before retrying.');
                this.git(['push', '--quiet', '--no-verify', `--force-with-lease=refs/heads/${validateBranch(run.conflictBranch)}:`, '--', this.remote, `${oid(run.journeyHead)}:refs/heads/${run.conflictBranch}`], { remote: true });
                published = true;
            }
        } catch (e) { error = e.message; }
        await this.api.post({ action: 'conflict_published', runId: run.id, published, ...(error ? { error } : {}) });
        return { status: 'conflict', journeyHead: run.journeyHead, remoteHead: run.remoteHead, conflictBranch: run.conflictBranch, published, ...(error ? { error } : {}) };
    }
    async prepare(run) {
        const original = oid(run.journeyHead), remote = run.remoteHead ? oid(run.remoteHead) : null;
        await this.upload(run.id, remote, [original]);
        const base = this.commonBase(original, remote);
        if (!run.prepared) await this.api.post({ action: 'prepare', runId: run.id, base });
        if (remote && !base) {
            await this.api.post({ action: 'conflict', runId: run.id, files: [], reason: 'unrelated_histories' });
            return { conflict: await this.publishConflict(run) };
        }
        let candidate = original, rewrites = {};
        if (remote && this.ancestor(original, remote)) candidate = remote;
        else if (remote && !this.ancestor(remote, original)) {
            const oldCommits = this.git(['rev-list', original, '^' + remote]).trim().split('\n').filter(Boolean);
            assert(oldCommits.length <= 2000, 'Synchronization limit: at most 2,000 unpublished commits can be rebased in one run.');
            rewrites = Object.fromEntries(oldCommits.map(id => [id, null]));
            this.git(['checkout', '--quiet', '--detach', original]);
            const rebased = this.git(['rebase', '--no-autostash', '--no-autosquash', '--no-gpg-sign', '--onto', remote, base], { allowFailure: true, rewrite: true });
            if (typeof rebased !== 'string') {
                const files = this.git(['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
                if (!files.length) throw new GitCommandError('rebase', rebased.status);
                await this.api.post({ action: 'conflict', runId: run.id, files });
                return { conflict: await this.publishConflict(run) };
            }
            candidate = oid(this.git(['rev-parse', 'HEAD']).trim());
            const mapping = await readFile(this.rewriteFile, 'utf8').catch(() => '');
            for (const line of mapping.trim().split('\n').filter(Boolean)) {
                const [old, replacement] = line.split(' ');
                assert(Object.hasOwn(rewrites, old) && OID.test(replacement), 'Git returned an unexpected rewritten commit mapping.');
                rewrites[old] = replacement;
            }
        }
        await this.upload(run.id, candidate, [original, remote]);
        await this.api.post({ action: 'stage', runId: run.id, head: candidate, rewrites });
        return { ...run, candidate, rewrites, phase: 'publishing', prepared: true };
    }
    async finish(run) {
        await this.api.post({ action: 'complete', runId: run.id, head: run.candidate });
        return { status: 'synced', head: run.candidate, previousHead: run.journeyHead, remoteHead: run.remoteHead };
    }
    async changedRemote(run) {
        const observed = this.fetchRemote();
        if (observed === run.candidate) return this.finish(run);
        assert(observed, 'The remote branch was deleted during synchronization. Synchronization is paused; restore the branch before retrying.');
        if (observed === run.remoteHead) throw new Error('The remote rejected the leased push. Check branch protection and local Git credentials, then retry.');
        await this.upload(run.id, observed, [run.journeyHead]);
        await this.api.post({ action: 'restart', runId: run.id, observedRemoteHead: observed });
        return { status: 'retry' };
    }
    async execute(state) {
        let run = state.sync.run;
        const observed = this.remoteHead();
        if (!run && observed === state.head) {
            if (!state.sync.lastCheckedAt || Date.now() - state.sync.lastCheckedAt >= 60000) await this.api.post({ action: 'observe', head: state.head, expectedRemote: this.remote, expectedBranch: this.branch });
            return { status: 'idle', head: state.head };
        }
        assert(observed || !state.sync.lastRemoteHead || run?.remoteHead === null, 'The tracked remote branch is missing. Restore it before retrying synchronization.');
        this.fetchJourney(run);
        if (!run) {
            const remoteHead = this.fetchRemote();
            const runId = randomUUID();
            await this.api.post({ action: 'begin', runId, expectedHead: state.head, remoteHead, expectedRemote: this.remote, expectedBranch: this.branch });
            run = (await this.api.get()).sync.run;
            assert(run?.id === runId, 'Synchronization run changed; retry to inspect its current state.');
        }
        this.currentRun = run;
        if (run.phase === 'conflict') return run.conflictPublished ? { status: 'conflict', journeyHead: run.journeyHead, remoteHead: run.remoteHead, conflictBranch: run.conflictBranch, published: true } : this.publishConflict(run);
        if (run.phase === 'resolving') {
            const resolved = this.fetchRemote();
            assert(resolved && resolved === run.resolutionHead, 'Remote main moved after the selected resolution. Select its current commit in Resume sync.');
            await this.upload(run.id, resolved, [run.journeyHead]);
            await this.api.post({ action: 'stage', runId: run.id, head: resolved, rewrites: {} });
            assert(this.remoteHead() === resolved, 'Remote main moved while importing the selected resolution. Select its current commit in Resume sync.');
            return this.finish({ ...run, candidate: resolved });
        }
        if (!run.candidate) {
            // A resumed run must rebuild from precisely the recorded remote, even if the branch has advanced.
            const current = this.remoteHead();
            if (current !== run.remoteHead) return this.changedRemote(run);
            if (run.remoteHead && !run.prepared) {
                const fetched = this.fetchRemote();
                if (fetched !== run.remoteHead) return this.changedRemote(run);
            }
            run = await this.prepare(run);
            if (run.conflict) return run.conflict;
            this.currentRun = run;
        }
        const current = this.remoteHead();
        if (current === run.candidate) return this.finish(run);
        if (current !== run.remoteHead) return this.changedRemote(run);
        try {
            this.git(['push', '--quiet', '--no-verify', `--force-with-lease=refs/heads/${this.branch}:${run.remoteHead ?? ''}`, '--', this.remote, `${oid(run.candidate)}:refs/heads/${this.branch}`], { remote: true });
        } catch { return this.changedRemote(run); }
        return this.finish(run);
    }
    async once() {
        for (let attempt = 0; attempt < 3; attempt++) {
            const state = await this.api.get();
            if (!state.sync?.enabled) return { status: 'disabled' };
            assert(!state.sync.run || !state.user?.agent || state.sync.run.actor === state.user.id, 'Another coordinator owns this synchronization run. Continue with its connection or the repository owner connection.');
            this.currentRun = state.sync.run;
            try {
                await this.workspace(state.sync);
                const result = await this.execute(state);
                if (result.status !== 'retry') return result;
            } catch (error) {
                const run = this.currentRun;
                if (run) {
                    // A completed request can lose its response. Never convert a completed run into an error.
                    const latest = await this.api.get().catch(() => null);
                    if (latest?.sync?.lastRunId === run.id) return { status: 'synced', head: latest.head };
                    await this.api.post({ action: 'fail', runId: run.id, error: error.message }).catch(() => {});
                }
                throw error;
            } finally { if (this.temp) await rm(this.temp, { recursive: true, force: true }); this.temp = undefined; }
        }
        throw new Error('Remote changed repeatedly. No remote changes were overwritten; retry synchronization.');
    }
}

const HELP = `Journey Git sync — Node.js 22+ and Git

node git-sync.mjs --connection journey-connection.json --once
node git-sync.mjs --connection journey-connection.json --watch [--interval 15]

Configure and enable the remote in repository Settings first. The watcher runs in
the foreground; stop it with Ctrl-C. It never changes your working checkout.
Alternatively set AVC_URL, AVC_PROJECT, AVC_TOKEN (and optional AVC_SITE_SERVICE_TOKEN).
SSH authentication and your local Git credential helper are used for the remote.
For HTTPS, optional GIT_SYNC_REMOTE_TOKEN / GIT_SYNC_REMOTE_USERNAME authenticate
only when GIT_SYNC_REMOTE_URL exactly matches that configured remote.
Never place credentials in the remote URL.
Conflicts pause repository writes. Resolve the published conflict branch using Git,
update the tracked remote branch, and select Resume sync in repository Settings.
`;

export async function main(argv = process.argv.slice(2), env = process.env) {
    if (argv.includes('--help') || !argv.length) { console.log(HELP); return; }
    let path, watch = false, once = false, interval = 15;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--connection') path = argv[++i];
        else if (argv[i] === '--watch') watch = true;
        else if (argv[i] === '--once') once = true;
        else if (argv[i] === '--interval') interval = Number(argv[++i]);
        else throw new Error('Unknown option. Run --help for usage.');
    }
    assert(watch !== once && Number.isFinite(interval) && interval >= 5 && interval <= 3600, 'Choose --once or --watch; --interval must be 5–3600 seconds.');
    const connection = path ? JSON.parse(await readFile(resolve(path), 'utf8')) : { url: env.AVC_URL, project: env.AVC_PROJECT, token: env.AVC_TOKEN, siteToken: env.AVC_SITE_SERVICE_TOKEN };
    const runner = new GitSyncRunner(connection, { env });
    do {
        try { console.log(JSON.stringify(await runner.once())); }
        catch (error) { console.error(error.message); if (!watch) { process.exitCode = 1; return; } }
        if (watch) await sleep(interval * 1000);
    } while (watch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(() => { console.error('Cannot start Git sync. Check your connection file and run --help for usage.'); process.exitCode = 1; });
}
