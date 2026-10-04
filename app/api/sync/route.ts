import { authorize, sameOrigin } from '@/lib/avc/auth';
import { bindings, mutate, readProject } from '@/lib/avc/storage';
import { GitStore, validPath } from '@/lib/avc/git';
import { ProtocolError, insist } from '@/lib/avc/core';
import { beginSync, completeSync, configureSync, conflictSync, currentSyncRun, failSync, observeSync, oid, prepareSync, resolveSync, restartSync, stageSync, syncOwner, syncReceipt, syncRunner } from '@/lib/avc/sync';
import { syncAncestor, syncBody, syncCommitMeta, syncTree, trustedSyncHeads, uploadSyncObjects, verifySyncClosure } from '@/lib/avc/sync-git';
import { env } from 'cloudflare:workers';
import { publicSync, storeCredential } from '@/lib/avc/github-cloud';
import { githubTarget } from '@/lib/avc/github-transport';

export const dynamic = 'force-dynamic';
function field(value: unknown, name: string, max = 100): string { insist(typeof value === 'string' && value.length > 0 && value.length <= max, 'invalid_input', `${name} is required.`, 400); return value; }
function failure(error: unknown) {
    if (error instanceof ProtocolError) return Response.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
    return Response.json({ error: 'The Git sync request could not be completed.', code: 'sync_error' }, { status: 500 });
}
export async function GET(req: Request) {
    try {
        const project = field(new URL(req.url).searchParams.get('project'), 'Repository');
        const user = await authorize(req, project); syncRunner(user);
        const { state } = await readProject(project);
        return Response.json({ head: state.head, sync: publicSync(state), user });
    } catch (error) { return failure(error); }
}
export async function POST(req: Request) {
    try {
        sameOrigin(req);
        const url = new URL(req.url);
        if (url.searchParams.get('op') === 'objects') {
            const project = field(url.searchParams.get('project'), 'Repository'), runId = field(url.searchParams.get('run'), 'Sync run');
            const user = await authorize(req, project); syncRunner(user);
            currentSyncRun((await readProject(project)).state, runId, user);
            const raw = await syncBody(req, 25_000_000);
            const { bucket } = bindings(), result = await uploadSyncObjects(new GitStore(bucket, project), bucket, raw);
            // Content-addressed orphan objects are harmless, but an expired run may not report successful publication.
            currentSyncRun((await readProject(project)).state, runId, user);
            return Response.json(result);
        }
        const raw = await syncBody(req, 1_000_000);
        let body: Record<string, unknown>;
        try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new ProtocolError('invalid_json', 'Supply a valid JSON request.', 400); }
        insist(body && typeof body === 'object' && !Array.isArray(body), 'invalid_request', 'Supply a JSON object.', 400);
        const project = field(body.project, 'Repository'), action = field(body.action, 'Action', 40);
        const user = await authorize(req, project); syncRunner(user);
        if (['configure', 'resolve', 'reconnect', 'cancel'].includes(action)) syncOwner(user);
        let credential: string | undefined;
        if (action === 'configure' && body.hosted === true) {
            githubTarget(field(body.remote, 'GitHub repository URL', 2000));
            if (body.token !== undefined && body.token !== '') {
                insist(env.GITHUB_SYNC_KEY, 'sync_credentials', 'The deployment must configure its cloud sync encryption secret first.', 503);
                credential = await storeCredential(project, field(body.token, 'GitHub token', 500), body.remote as string, env.GITHUB_SYNC_KEY);
            }
        }
        let reconnectRemote: string | undefined;
        if (action === 'reconnect') {
            const current = (await readProject(project)).state.sync;
            insist(current?.cloud, 'hosted_sync', 'This repository does not use hosted GitHub sync.', 409);
            insist(env.GITHUB_SYNC_KEY, 'sync_credentials', 'Configure the deployment encryption secret first.', 503);
            reconnectRemote = current.remote;
            credential = await storeCredential(project, field(body.token, 'GitHub token', 500), current.remote, env.GITHUB_SYNC_KEY);
        }
        const git = new GitStore(bindings().bucket, project);
        const result = await mutate(project, async state => {
            if (action === 'reconnect') {
                insist(state.sync?.cloud && state.sync.remote === reconnectRemote && credential, 'sync_target_changed', 'Repository target changed; reconnect again.', 409);
                state.sync.cloud.credential = credential; state.sync.cloud.generation = crypto.randomUUID(); delete state.sync.cloud.nextAttemptAt;
                state.sync.cloud.failures = 0; state.sync.status = state.sync.run?.phase === 'conflict' ? 'conflict' : state.sync.run ? 'running' : 'idle'; delete state.sync.error;
                return { reconnected: true };
            }
            if (action === 'cancel') {
                insist(state.sync?.cloud, 'hosted_sync', 'This repository does not use hosted GitHub sync.', 409);
                const lease = state.sync.cloud.lease;
                insist(!lease || lease.until + 40_000 < Date.now(), 'sync_running', 'Wait for the active cloud execution to finish before cancelling.', 409);
                state.sync.cloud.generation = crypto.randomUUID(); delete state.sync.cloud.lease; delete state.sync.cloud.work; delete state.sync.run;
                state.sync.enabled = false; state.sync.status = 'idle'; delete state.sync.error;
                return { cancelled: true, head: state.head };
            }
            if (action === 'configure') {
                if (body.hosted !== true) { insist(!state.sync?.cloud, 'hosted_sync', 'Hosted sync configuration must retain its hosted mode.', 409); return configureSync(state, { remote: body.remote, branch: body.branch, enabled: body.enabled }, user); }
                const previous = state.sync, same = previous?.remote === body.remote && previous?.branch === body.branch;
                const selected = credential ?? (same ? previous?.cloud?.credential : undefined);
                insist(body.enabled === false || selected, 'sync_credentials', 'Connect a repository-scoped GitHub token before enabling hosted sync.', 400);
                const configured = configureSync(state, { remote: body.remote, branch: body.branch, enabled: body.enabled }, user);
                if (selected) configured.cloud = { credential: selected, generation: crypto.randomUUID() };
                return { configured: true };
            }
            if (state.sync?.cloud && action !== 'resolve') throw new ProtocolError('hosted_sync', 'This repository uses hosted GitHub sync; local runner actions are disabled.', 409);
            if (action === 'begin') return beginSync(state, { runId: body.runId, expectedHead: body.expectedHead, remoteHead: body.remoteHead, expectedRemote: body.expectedRemote, expectedBranch: body.expectedBranch }, user);
            if (action === 'observe') return observeSync(state, { head: body.head, expectedRemote: body.expectedRemote, expectedBranch: body.expectedBranch }, user);
            const receipt = syncReceipt(state, body.runId, user);
            if (receipt && ((action === 'complete' && receipt.completed) || (action === 'restart' && receipt.restarted))) {
                if (action === 'complete') insist(oid(body.head) === receipt.head, 'idempotency_conflict', 'This run completed a different head.');
                return receipt;
            }
            const run = currentSyncRun(state, body.runId, user), trusted = trustedSyncHeads(state);
            if (action === 'prepare') {
                const base = body.base === null ? null : oid(body.base);
                if (run.prepared) {
                    insist(run.base === base, 'idempotency_conflict', 'This run was prepared with another base.');
                    return run;
                }
                if (run.remoteHead) {
                    await verifySyncClosure(git, run.remoteHead, trusted);
                    if (base) insist(await syncAncestor(git, base, run.journeyHead) && await syncAncestor(git, base, run.remoteHead), 'invalid_base', 'The sync base must be a common ancestor.');
                } else insist(base === null, 'invalid_base', 'An empty remote has no common base.', 400);
                const original = await syncTree(git, run.journeyHead), incoming = run.remoteHead ? await syncTree(git, run.remoteHead) : null, common = base ? await syncTree(git, base) : null;
                return prepareSync(state, run, base, original, incoming, common);
            }
            if (action === 'stage') {
                const head = oid(body.head), input = body.rewrites ?? {};
                insist(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length <= 2000, 'invalid_rewrites', 'Supply at most 2,000 commit rewrite mappings.', 400);
                const rewrites: Record<string, string | null> = {};
                for (const [before, after] of Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) rewrites[oid(before)] = after === null ? null : oid(after);
                await verifySyncClosure(git, head, trusted);
                if (run.phase !== 'resolving' && run.remoteHead) insist(await syncAncestor(git, run.remoteHead, head), 'remote_history_missing', 'The staged result must include the captured remote history.');
                return stageSync(state, run, head, rewrites);
            }
            if (action === 'complete') {
                insist(run.candidate, 'sync_not_staged', 'Stage a result before completing sync.');
                insist(oid(body.head) === run.candidate, 'sync_candidate_changed', 'The staged result changed. Read the current sync run before continuing.');
                return completeSync(state, run, await syncTree(git, run.journeyHead), await syncTree(git, run.candidate), await syncCommitMeta(git, run.candidate));
            }
            if (action === 'conflict') {
                insist(Array.isArray(body.files) && body.files.length <= 4000 && body.files.every(path => typeof path === 'string' && validPath(path)), 'invalid_conflicts', 'Supply valid conflicting repository paths.', 400);
                insist(body.reason === undefined || body.reason === 'rebase_conflict' || body.reason === 'unrelated_histories', 'invalid_conflict', 'Unknown conflict reason.', 400);
                return conflictSync(state, run, [...new Set(body.files as string[])].sort(), body.reason);
            }
            if (action === 'conflict_published') {
                insist(run.phase === 'conflict' || run.phase === 'resolving', 'invalid_sync_phase', 'No conflict branch is awaiting publication.');
                insist(typeof body.published === 'boolean', 'invalid_input', 'Published must be a boolean.', 400);
                if (body.published) { run.conflictPublished = true; delete run.conflictPublishError; }
                else if (!run.conflictPublished) { run.conflictPublished = false; run.conflictPublishError = 'The conflict branch could not be published. Retry the runner before resolving.'; }
                state.sync!.updatedAt = Date.now();
                return run;
            }
            if (action === 'fail') return failSync(state, run);
            if (action === 'resolve') {
                const lease = state.sync?.cloud?.lease;
                insist(!lease || lease.until + 40_000 < Date.now(), 'sync_running', 'Wait for the active cloud execution to finish before changing its resolution.', 409);
                const resolved = resolveSync(state, run, oid(body.head), user);
                if (state.sync!.cloud) {
                    state.sync!.cloud!.generation = crypto.randomUUID(); delete state.sync!.cloud!.lease; delete state.sync!.cloud!.nextAttemptAt;
                    state.sync!.cloud!.work = { phase: 'import', remote: resolved.resolutionHead!, original: run.journeyHead, todo: [{ hash: resolved.resolutionHead!, type: 'commit' }], seen: [] };
                }
                return resolved;
            }
            if (action === 'restart') {
                const head = oid(body.observedRemoteHead);
                await verifySyncClosure(git, head, trusted);
                return restartSync(state, run, head);
            }
            throw new ProtocolError('unknown_action', 'Unknown Git sync action.', 400);
        });
        return Response.json({ result });
    } catch (error) { return failure(error); }
}
