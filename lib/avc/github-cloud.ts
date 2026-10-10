import { importCloudBatch } from './cloud-import.ts';
import { syncView } from './sync-view.ts';
import { GitStore, makeCommit } from './git.ts';
import { ancestryCloudBatch, type Ancestry } from './cloud-ancestry.ts';
import { exportCloudBatch, type ExportItem } from './cloud-export.ts';
import { providerTransport, remoteProvider } from './provider-transport.ts';
import { connectionToken, encrypt } from './oauth.ts';
import { emit, insist, notifyWaiters, ProtocolError, type State } from './core.ts';
import { bindings, mutate, readProject } from './storage.ts';
import { syncCommitMeta } from './sync-git.ts';
import { beginSync, conflictSync, currentSyncRun, observeSync, stageSync } from './sync.ts';

type Item = ExportItem;
export type CloudWork = { phase: 'import' | 'remote-ancestry' | 'journey-ancestry' | 'export' | 'publish'; remote: string | null; original: string; todo: Item[]; seen: string[]; transferHead?: string; candidate?: string; preserve?: boolean; initialized?: boolean; importVersion?: 1; ancestry?: Ancestry; exportVersion?: 1; baselineTree?: string; importBaselineTree?: string };
const actor = { id: 'cloud-github-sync', agent: false };
const BATCH = 20;
const utf8 = new TextEncoder();
function secretKey(value: string) {
    insist(/^[a-f0-9]{64}$/.test(value), 'sync_credentials', 'Cloud sync encryption key must be configured as a 32-byte hexadecimal Worker secret.', 503);
    return crypto.subtle.importKey('raw', Buffer.from(value, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function storeCredential(project: string, token: string, remote: string, key: string) {
    insist(typeof token === 'string' && token.length >= 10 && token.length <= 500 && !/[\x00-\x20\x7f]/.test(token), 'invalid_token', 'Supply a repository-scoped GitHub access token.', 400);
    const transport = providerTransport(remote, token);
    // Authentication happens before changing configuration. Token permissions
    // still apply at every object and ref operation, including expiration.
    await transport.authorizeRepository();
    const credential = crypto.randomUUID(), iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(`${project}:${remote}:${credential}`) }, await secretKey(key), utf8.encode(token));
    await bindings().bucket.put(`${project}/cloud-credentials/${credential}`, JSON.stringify({ iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') }));
    return credential;
}
export async function storeOAuthCredential(project: string, user: string, remote: string, key: string) {
    const provider = remoteProvider(remote), token = await connectionToken(user, provider, key);
    await providerTransport(remote, token).authorizeRepository(true);
    const credential = crypto.randomUUID();
    // Store a binding to the owner account, never a copy of its rotating token.
    await bindings().bucket.put(`${project}/cloud-credentials/${credential}`, await encrypt(JSON.stringify({ oauth: true, user, provider }), `${project}:${remote}:${credential}`, key));
    return credential;
}
async function credential(project: string, state: State, key: string) {
    const sync = state.sync!;
    const stored = await bindings().bucket.get(`${project}/cloud-credentials/${sync.cloud!.credential}`);
    insist(stored, 'sync_credentials', 'Reconnect this repository’s GitHub token.', 503);
    const value = JSON.parse(await stored.text()) as { iv: string; ciphertext: string };
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(value.iv, 'base64'), additionalData: utf8.encode(`${project}:${sync.remote}:${sync.cloud!.credential}`) }, await secretKey(key), Buffer.from(value.ciphertext, 'base64'));
    const valueText = new TextDecoder().decode(plaintext);
    if (valueText.startsWith('{')) {
        const link = JSON.parse(valueText) as { oauth: boolean; user: string; provider: string };
        const owner = await bindings().db.prepare('SELECT owner FROM projects WHERE id=?').bind(project).first<{ owner: string }>();
        insist(link.oauth && owner?.owner === link.user && remoteProvider(sync.remote) === link.provider, 'sync_credentials', 'Reconnect this repository owner’s provider account.', 403);
        return connectionToken(link.user, remoteProvider(sync.remote), key);
    }
    return valueText;
}
function fence(state: State, token: string, generation: string) {
    insist(state.sync?.enabled && state.sync.cloud?.generation === generation && state.sync.cloud.lease?.token === token && state.sync.cloud.lease.until > Date.now(), 'sync_lease_lost', 'This cloud sync execution was superseded.', 409);
    return state.sync.cloud;
}
// Only the exact, never-used creation revision is a disposable bootstrap.
// An empty imported root or a later commit deleting all files is real history.
function pristineBootstrap(state: State, work: CloudWork) {
    const created = state.events[0], meta = state.revisions[work.original];
    return state.head === work.original && state.integrationCursor === 0 &&
        !state.imported && !state.importSession && state.journeys.length === 0 &&
        state.leases.length === 0 && state.waiting.length === 0 &&
        Object.keys(state.revisions).length === 1 && !!meta && !meta.parent &&
        meta.message === 'Initialize repository' && Number.isFinite(meta.at) &&
        created?.type === 'repository.created' && created.id === 1 && created.data.revision === work.original &&
        !state.sync?.lastSyncedHead && !state.sync?.lastCompletedHead &&
        !Object.keys(state.sync?.receipts ?? {}).length;
}
export function publicSync(state: State) {
    if (!state.sync) return null;
    return syncView(state.sync);
}
async function finish(project: string, token: string, generation: string, candidate: string, git: GitStore) {
    const meta = await syncCommitMeta(git, candidate);
    await mutate(project, state => {
        const cloud = fence(state, token, generation), run = currentSyncRun(state, state.sync!.run!.id, actor);
        insist(run.candidate === candidate, 'sync_candidate_changed', 'Cloud sync candidate changed.', 409);
        const previous = state.head;
        if (previous !== candidate) {
            // Conservative invalidation avoids a repository-wide editable file
            // snapshot in this pass-through path. Workers reacquire after reconcile.
            for (const lease of state.leases) emit(state, 'lock.invalidated', actor.id, { runId: run.id, reason: 'Git remote advanced Journey main; reacquire after reconciliation.', locks: [{ id: lease.id, generation: lease.generation, path: lease.path }] }, lease.journey, [lease.journey]);
            state.leases = [];
            for (const journey of state.journeys) if (journey.status === 'working' || journey.status === 'review') for (const review of journey.reviews) if (review.kind === 'approve') review.resolved = true;
            state.revisions[candidate] = meta; state.head = candidate;
            state.integrationCursor = emit(state, 'repository.synced', actor.id, { runId: run.id, previous, revision: candidate, remoteHead: run.remoteHead, external: true, rewrites: {} }).id;
            notifyWaiters(state);
        }
        const sync = state.sync!;
        sync.lastSyncedHead = candidate; sync.lastRemoteHead = candidate; sync.lastCompletedHead = candidate; sync.lastRunId = run.id; sync.lastCheckedAt = Date.now(); sync.updatedAt = Date.now(); sync.status = 'idle';
        sync.receipts ??= {}; sync.receipts[run.id] = { actor: run.actor, journeyHead: run.journeyHead, remoteHead: run.remoteHead, head: candidate, completed: true };
        delete sync.run; delete sync.error; delete cloud.work; cloud.failures = 0; cloud.nextAttemptAt = Date.now() + 240_000;
    });
}
export async function runCloudSync(project: string, key: string) {
    const execution = AbortSignal.timeout(60_000), token = crypto.randomUUID(); let generation: string | undefined;
    const claimed = await mutate(project, state => {
        const sync = state.sync, cloud = sync?.cloud;
        if (!sync?.enabled || !cloud || sync.status === 'conflict' || (cloud.lease && cloud.lease.until > Date.now()) || (cloud.nextAttemptAt ?? 0) > Date.now()) return false;
        generation = cloud.generation; cloud.lease = { token, until: Date.now() + 90_000 }; if (sync.run) sync.status = 'running'; delete sync.error; return true;
    });
    if (!claimed || !generation) return false;
    const ownedGeneration = generation;
    const assertOwnership = async () => {
        execution.throwIfAborted();
        fence((await readProject(project)).state, token, ownedGeneration);
        execution.throwIfAborted();
    };
    try {
        let state = (await readProject(project)).state;
        const sync = state.sync!, cloud = fence(state, token, ownedGeneration), git = new GitStore(bindings().bucket, project);
        const remote = providerTransport(sync.remote, await credential(project, state, key), fetch, execution, `journey-objects/${project}/${cloud.generation}`, assertOwnership);
        if (!cloud.work) {
            const head = await remote.head(sync.branch);
            await mutate(project, state => {
                const owned = fence(state, token, ownedGeneration);
                if (head === state.head) { observeSync(state, { head, expectedRemote: state.sync!.remote, expectedBranch: state.sync!.branch }, actor); owned.nextAttemptAt = Date.now() + 240_000; return; }
                const run = beginSync(state, { runId: crypto.randomUUID(), expectedHead: state.head, remoteHead: head, expectedRemote: state.sync!.remote, expectedBranch: state.sync!.branch }, actor);
                owned.work = { phase: head ? 'import' : 'export', remote: head, original: run.journeyHead, todo: [{ hash: head ?? run.journeyHead, type: 'commit' }], seen: [] };
            });
        }
        const deadline = Date.now() + 45_000;
        for (let count = 0; count < BATCH && Date.now() < deadline; count++) {
            state = (await readProject(project)).state;
            if (state.sync?.status === 'conflict') break;
            const owned = fence(state, token, ownedGeneration), work = owned.work;
            if (!work) break;
            // Reaching ancestry/export proves the import closure finished, including
            // old persisted runs that failed exporting the empty bootstrap tree.
            if (work.remote && (work.phase === 'remote-ancestry' || work.phase === 'journey-ancestry' || (work.phase === 'export' && work.preserve)) && pristineBootstrap(state, work)) {
                const meta = state.revisions[work.original];
                const bootstrap = await makeCommit({}, undefined, meta.message, meta.actor, meta.at);
                if (bootstrap.oid === work.original) {
                    await mutate(project, state => {
                        const current = fence(state, token, ownedGeneration).work!;
                        const run = currentSyncRun(state, state.sync!.run!.id, actor);
                        insist(pristineBootstrap(state, current) && current.original === work.original && current.remote === work.remote && run.remoteHead === current.remote && run.phase === 'preparing', 'sync_progress_changed', 'Bootstrap sync changed.', 409);
                        // beginSync already keeps the original commit as a backup.
                        state.sync!.backupRefs![`refs/heads/journey-sync/${run.id}/remote`] = current.remote!;
                        current.phase = 'publish'; current.candidate = current.remote!; current.todo = []; current.seen = []; delete current.preserve;
                        run.prepared = true; stageSync(state, run, current.candidate, {});
                    });
                    continue;
                }
            }
            if (work.phase === 'export' && work.remote === null && !work.initialized) {
                // GitHub Git database APIs reject genuinely empty repositories.
                // A two-object empty-tree bootstrap touches only our scratch ref;
                // the user's target branch remains absent until real closure lands.
                const head = await remote.initializeTransfer(`refs/heads/journey-transfer/${project}/${state.sync!.run!.id}`, assertOwnership);
                await mutate(project, state => { const current = fence(state, token, ownedGeneration).work!; current.transferHead = head; current.initialized = true; });
                continue;
            }
            if (work.phase === 'import' && (work.todo.length || work.importVersion !== 1)) {
                const before = JSON.stringify(work);
                await importCloudBatch(project, bindings().bucket, work, new Set([work.original, state.sync!.lastSyncedHead].filter((head): head is string => !!head)),
                    (hash, type) => remote.read(hash, type), () => execution.throwIfAborted(), Math.min(deadline, Date.now() + 5_000), work.original);
                execution.throwIfAborted();
                await mutate(project, state => {
                    const current = fence(state, token, ownedGeneration);
                    insist(JSON.stringify(current.work) === before, 'sync_progress_changed', 'Cloud work changed.', 409);
                    current.work = work;
                });
                continue;
            }
            if (work.phase === 'remote-ancestry' || work.phase === 'journey-ancestry') {
                const before = JSON.stringify(work);
                const direction = await ancestryCloudBatch(work, git, state.sync!.lastSyncedHead, () => execution.throwIfAborted(), Math.min(deadline, Date.now() + 5_000));
                execution.throwIfAborted();
                await mutate(project, state => {
                    const current = fence(state, token, ownedGeneration);
                    insist(JSON.stringify(current.work) === before, 'sync_progress_changed', 'Cloud work changed.', 409);
                    current.work = work;
                    if (direction) {
                        delete work.ancestry; work.seen = []; work.todo = [];
                        if (direction === 'incoming') {
                            work.phase = 'publish'; work.candidate = work.remote!;
                            const run = state.sync!.run!; run.prepared = true; stageSync(state, run, work.candidate, {});
                        } else {
                            work.phase = 'export'; work.preserve = direction === 'diverged';
                            work.todo = [{ hash: work.original, type: 'commit' }];
                        }
                    }
                });
                continue;
            }
            if (work.phase === 'export' && (work.todo.length || work.exportVersion !== 1)) {
                const before = JSON.stringify(work);
                await exportCloudBatch(work, git, remote, `journey-transfer/${project}/${state.sync!.run!.id}`, () => execution.throwIfAborted(), assertOwnership, Math.min(deadline, Date.now() + 5_000));
                execution.throwIfAborted();
                await mutate(project, state => {
                    const current = fence(state, token, ownedGeneration);
                    insist(JSON.stringify(current.work) === before, 'sync_progress_changed', 'Cloud work changed.', 409);
                    current.work = work;
                });
                continue;
            }
            if (work.phase === 'publish') {
                const candidate = work.candidate!, currentRemote = await remote.head(state.sync!.branch);
                if (currentRemote !== candidate) {
                    insist(currentRemote === work.remote, 'remote_head_moved', 'Git remote branch moved during synchronization. Retry captures the new head.', 409);
                    await assertOwnership();
                    await remote.push(`refs/heads/${state.sync!.branch}`, work.remote, candidate);
                }
                await finish(project, token, ownedGeneration, candidate, git); break;
            }
            if (work.phase === 'export' && work.preserve) {
                const branch = state.sync!.run!.conflictBranch, head = await remote.head(branch);
                if (head !== work.original) {
                    insist(head === null, 'conflict_ref_exists', 'The conflict preservation branch already contains another revision; it was not overwritten.', 409);
                    await assertOwnership();
                    await remote.push(`refs/heads/${branch}`, null, work.original);
                }
            }
            await mutate(project, state => {
                const current = fence(state, token, ownedGeneration).work!, run = state.sync!.run!;
                if (current.phase === 'import') {
                    if (run.phase === 'resolving') { insist(run.resolutionHead === current.remote, 'resolution_changed', 'Resolved remote head changed.', 409); current.phase = 'publish'; current.candidate = current.remote!; stageSync(state, run, current.remote!, {}); }
                    else { current.phase = 'remote-ancestry'; current.todo = [{ hash: current.remote!, type: 'commit' }]; current.seen = []; }
                }
                else if (current.phase === 'export') {
                    if (current.preserve) { conflictSync(state, run, [], 'rebase_conflict'); run.conflictPublished = true; state.sync!.error = 'Both branches changed. Merge the preserved Journey revision with the remote branch, then select that resolved remote head.'; }
                    else { current.phase = 'publish'; current.candidate = current.original; run.prepared = true; stageSync(state, run, current.original, {}); }
                }
            });
        }
    } catch (error) {
        if (error instanceof ProtocolError && error.code === 'sync_lease_lost') return true;
        await mutate(project, state => {
            const cloud = fence(state, token, ownedGeneration), sync = state.sync!;
            if (error instanceof ProtocolError && error.code === 'remote_head_moved' && sync.run?.phase !== 'resolving') { delete cloud.work; delete sync.run; sync.status = 'idle'; }
            else { sync.status = 'error'; sync.error = error instanceof ProtocolError ? error.message : 'Cloud Git sync failed. Reconnect credentials or retry; both heads are preserved.'; }
            cloud.failures = Math.min((cloud.failures ?? 0) + 1, 8); cloud.nextAttemptAt = Date.now() + Math.min(300_000 * 2 ** (cloud.failures - 1), 3_600_000);
            if (error instanceof ProtocolError && error.details !== null && typeof error.details === 'object' && 'retryAt' in error.details && typeof error.details.retryAt === 'number' && Number.isFinite(error.details.retryAt)) cloud.nextAttemptAt = Math.max(cloud.nextAttemptAt, error.details.retryAt);
        }).catch(() => undefined);
    } finally {
        await mutate(project, state => { if (state.sync?.cloud?.generation === ownedGeneration && state.sync.cloud.lease?.token === token) delete state.sync.cloud.lease; }).catch(() => undefined);
    }
    return true;
}
export async function scheduledGitHubSync(queue: Queue<{ project: string }>) {
    const { db, bucket } = bindings();
    const cursorKey = 'cloud-sync/scheduler-cursor';
    const cursor = await bucket.get(cursorKey), after = cursor ? await cursor.text() : '';
    let last = after;
    // Discovery only: each repository runs independently with a fresh consumer
    // CPU budget. Bound producer work while retaining a fair cursor for >10k repos.
    for (let page = 0; page < 100; page++) {
        const rows = await db.prepare('SELECT id FROM projects WHERE id > ? ORDER BY id LIMIT 100').bind(last).all<{ id: string }>();
        if (rows.results.length) await queue.sendBatch(rows.results.map(row => ({ body: { project: row.id } })));
        last = rows.results.at(-1)?.id ?? '';
        if (rows.results.length < 100) { last = ''; break; }
    }
    await bucket.put(cursorKey, last);
}
