import { deflateSync } from 'node:zlib';
import { GitStore, object, parseTree, references } from './git.ts';
import { providerTransport, remoteProvider } from './provider-transport.ts';
import { connectionToken, encrypt } from './oauth.ts';
import { emit, insist, notifyWaiters, ProtocolError, type State } from './core.ts';
import { bindings, mutate, readProject } from './storage.ts';
import { syncCommitMeta } from './sync-git.ts';
import { beginSync, conflictSync, currentSyncRun, observeSync, stageSync } from './sync.ts';

type ObjectType = 'commit' | 'tree' | 'blob';
type Item = { hash: string; type: ObjectType; expanded?: boolean; depth?: number; path?: string };
export type CloudWork = { phase: 'import' | 'remote-ancestry' | 'journey-ancestry' | 'export' | 'publish'; remote: string | null; original: string; todo: Item[]; seen: string[]; transferHead?: string; candidate?: string; preserve?: boolean; initialized?: boolean };
const actor = { id: 'cloud-github-sync', agent: false };
const MAX_OBJECTS = 50_000;
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
function children(type: ObjectType, body: Uint8Array, parent?: Item): Item[] {
    if (type === 'blob') return [];
    if (type === 'tree') {
        insist((parent?.depth ?? 0) <= 40, 'tree_capacity', 'GitHub tree nesting exceeds Journey’s tree depth limit.', 413);
        return parseTree(body).flatMap(entry => {
            const path = `${parent?.path ?? ''}${entry.name}`;
            insist(path.length <= 1000, 'tree_capacity', 'GitHub tree path exceeds Journey’s path limit.', 413);
            return entry.mode === '160000' ? [] : [{ hash: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob', depth: (parent?.depth ?? 0) + 1, path: path + '/' }];
        });
    }
    const text = new TextDecoder().decode(body).split('\n\n')[0];
    references('commit', body);
    return [...text.matchAll(/^(tree|parent) ([a-f0-9]{40})$/gm)].map(entry => ({ hash: entry[2], type: entry[1] === 'tree' ? 'tree' : 'commit', ...(entry[1] === 'tree' ? { depth: 0, path: '' } : {}) }));
}
function parents(body: Uint8Array): Item[] { return children('commit', body).filter(entry => entry.type === 'commit'); }
function fence(state: State, token: string, generation: string) {
    insist(state.sync?.enabled && state.sync.cloud?.generation === generation && state.sync.cloud.lease?.token === token && state.sync.cloud.lease.until > Date.now(), 'sync_lease_lost', 'This cloud sync execution was superseded.', 409);
    return state.sync.cloud;
}
function remember(work: CloudWork, hash: string) {
    if (!work.seen.includes(hash)) work.seen.push(hash);
    insist(work.seen.length <= MAX_OBJECTS && work.todo.length <= MAX_OBJECTS, 'sync_capacity', 'Cloud sync exceeds 50,000 objects; heads are preserved.', 413);
}
function seenKey(work: CloudWork, item: Item) { return work.phase === 'import' && item.type === 'tree' ? `${item.hash}:${item.depth ?? 0}:${item.path ?? ''}` : item.hash; }
export function publicSync(state: State) {
    if (!state.sync) return null;
    const { cloud, ...sync } = state.sync;
    return { ...sync, ...(cloud ? { hosted: true, progress: cloud.work ? { phase: cloud.work.phase, objects: cloud.work.seen.length, pending: cloud.work.todo.length } : null, nextAttemptAt: cloud.nextAttemptAt } : {}) };
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
            if (work.phase === 'export' && work.remote === null && !work.initialized) {
                // GitHub Git database APIs reject genuinely empty repositories.
                // A two-object empty-tree bootstrap touches only our scratch ref;
                // the user's target branch remains absent until real closure lands.
                const head = await remote.initializeTransfer(`refs/heads/journey-transfer/${project}/${state.sync!.run!.id}`, assertOwnership);
                await mutate(project, state => { const current = fence(state, token, ownedGeneration).work!; current.transferHead = head; current.initialized = true; });
                continue;
            }
            const item = work.todo.at(-1);
            if (item) {
                let next: Item[] = [], completed = true, transferHead: string | undefined;
                if (!work.seen.includes(seenKey(work, item))) {
                    if (work.phase === 'import') {
                        // Only verified complete Journey heads are closure cutpoints.
                        if (item.hash !== work.original && item.hash !== state.sync!.lastSyncedHead) {
                            const stored = await bindings().bucket.head(git.key(item.hash));
                            const body = stored ? (await git.read(item.hash)).body : await remote.read(item.hash, item.type);
                            insist((await object(item.type, body)).oid === item.hash, 'invalid_object', 'Stored Git object hash/type mismatch.', 400);
                            if (!stored) await bindings().bucket.put(git.key(item.hash), deflateSync((await object(item.type, body)).raw));
                            next = children(item.type, body, item);
                        }
                    } else if (work.phase === 'remote-ancestry' || work.phase === 'journey-ancestry') {
                        const target = work.phase === 'remote-ancestry' ? work.original : work.remote;
                        if (item.hash === target) {
                            await mutate(project, state => {
                                const current = fence(state, token, ownedGeneration).work!;
                                const run = state.sync!.run!;
                                if (current.phase === 'remote-ancestry') { current.candidate = current.remote!; current.phase = 'publish'; current.todo = []; run.prepared = true; stageSync(state, run, current.candidate, {}); }
                                else { current.phase = 'export'; current.todo = [{ hash: current.original, type: 'commit' }]; current.seen = []; }
                            });
                            continue;
                        }
                        next = parents((await git.read(item.hash)).body);
                    } else if (work.phase === 'export') {
                        const exists = await remote.has(item.hash, item.type);
                        const branch = `journey-transfer/${project}/${state.sync!.run!.id}`;
                        if (exists && item.type === 'commit') {
                            const published = await remote.head(branch);
                            insist(published === null || published === work.transferHead || published === item.hash, 'conflict_ref_exists', 'The preservation branch changed; it was not overwritten.', 409);
                            if (published === item.hash) transferHead = item.hash;
                        }
                        if (!exists) {
                            const value = await git.read(item.hash); insist(value.type === item.type, 'invalid_object', 'Git object has an unexpected type.', 400);
                            if (!item.expanded) { next = children(item.type, value.body, item); completed = next.length === 0; }
                            if (completed) {
                                if (item.type === 'commit') {
                                    const old = await remote.head(branch);
                                    insist(old === null || old === work.transferHead || old === item.hash, 'conflict_ref_exists', 'The preservation branch changed; it was not overwritten.', 409);
                                    if (old !== item.hash) { await assertOwnership(); await remote.push(`refs/heads/${branch}`, old, item.hash, value.body); }
                                    transferHead = item.hash;
                                } else { await assertOwnership(); await remote.write(item.hash, item.type, value.body); }
                            }
                        }
                    }
                }
                await mutate(project, state => {
                    const current = fence(state, token, ownedGeneration).work!;
                    insist(current.phase === work.phase && current.todo.at(-1)?.hash === item.hash, 'sync_progress_changed', 'Cloud work changed.', 409);
                    if (completed) { current.todo.pop(); remember(current, seenKey(current, item)); }
                    else current.todo[current.todo.length - 1].expanded = true;
                    current.todo.push(...next.filter(entry => !current.seen.includes(seenKey(current, entry))));
                    if (transferHead) current.transferHead = transferHead;
                    insist(current.todo.length <= MAX_OBJECTS, 'sync_capacity', 'Object traversal capacity exceeded.', 413);
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
                else if (current.phase === 'remote-ancestry') { current.phase = 'journey-ancestry'; current.todo = [{ hash: current.original, type: 'commit' }]; current.seen = []; }
                else if (current.phase === 'journey-ancestry') { current.phase = 'export'; current.preserve = true; current.todo = [{ hash: current.original, type: 'commit' }]; current.seen = []; }
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
