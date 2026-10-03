import { authorize, sameOrigin } from '@/lib/avc/auth';
import { bindings, mutate, readProject } from '@/lib/avc/storage';
import { GitStore, validPath } from '@/lib/avc/git';
import { ProtocolError, insist } from '@/lib/avc/core';
import { beginSync, completeSync, configureSync, conflictSync, currentSyncRun, failSync, observeSync, oid, prepareSync, resolveSync, restartSync, stageSync, syncOwner, syncReceipt, syncRunner } from '@/lib/avc/sync';
import { syncAncestor, syncBody, syncCommitMeta, syncTree, trustedSyncHeads, uploadSyncObjects, verifySyncClosure } from '@/lib/avc/sync-git';

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
        return Response.json({ head: state.head, sync: state.sync ?? null, user });
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
        if (action === 'configure' || action === 'resolve') syncOwner(user);
        const git = new GitStore(bindings().bucket, project);
        const result = await mutate(project, async state => {
            if (action === 'configure') return configureSync(state, { remote: body.remote, branch: body.branch, enabled: body.enabled }, user);
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
            if (action === 'resolve') return resolveSync(state, run, oid(body.head), user);
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
