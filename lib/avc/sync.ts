import { diff, emit, insist, notifyWaiters, remap, touches, type Files, type Lease, type Reviewer, type State } from './core.ts';
import type { Entries } from './git.ts';

export type SyncRun = {
    id: string;
    actor: string;
    journeyHead: string;
    remoteHead: string | null;
    base?: string | null;
    phase: 'preparing' | 'publishing' | 'conflict' | 'resolving';
    prepared?: boolean;
    candidate?: string;
    rewrites?: Record<string, string | null>;
    conflictBranch: string;
    conflicts?: string[];
    conflictReason?: 'rebase_conflict' | 'unrelated_histories';
    conflictPublished?: boolean;
    conflictPublishError?: string;
    resolutionHead?: string;
};
export type SyncState = {
    remote: string;
    branch: string;
    enabled: boolean;
    status: 'idle' | 'running' | 'conflict' | 'error';
    updatedAt: number;
    lastCheckedAt?: number;
    lastSyncedHead?: string;
    lastRemoteHead?: string;
    lastRunId?: string;
    lastCompletedHead?: string;
    error?: string;
    run?: SyncRun;
    backupRefs?: Record<string, string>;
    receipts?: Record<string, { actor: string; journeyHead: string; remoteHead: string | null; head: string; completed?: true; restarted?: true }>;
};
export type SyncTree = { entries: Entries; files: Files };
export const validOid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function oid(value: unknown) { insist(validOid(value), 'invalid_revision', 'Supply a complete SHA-1 commit ID.', 400); return value; }
export function syncRunner(user: Reviewer) { insist(!user.agent || user.role === 'coordinator', 'forbidden', 'Git sync requires the repository owner or coordinator.', 403); }
export function syncOwner(user: Reviewer) { insist(!user.agent, 'forbidden', 'Only the repository owner can configure or resolve Git sync.', 403); }
export function assertSyncWritable(s: State, action?: string) {
    insist(!s.sync?.run || (action === 'refresh' && s.sync.status === 'running' && s.sync.run.phase !== 'conflict'), 'sync_paused', 'Repository writes are paused while Git sync completes or awaits recovery.', 409, { runId: s.sync?.run?.id, status: s.sync?.status });
}
function branchName(value: unknown) {
    insist(typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.startsWith('-') && !value.startsWith('refs/') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.includes('//') && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')) && value !== '@', 'invalid_branch', 'Supply a valid branch name without refs/heads/.', 400);
    return value;
}
function remoteAddress(value: unknown) {
    insist(typeof value === 'string' && value.length <= 2000 && !/[\x00-\x20\x7f]/.test(value), 'invalid_remote', 'Use a credential-free HTTPS or SSH Git remote.', 400);
    if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_./~-]+$/.test(value)) return value;
    let url: URL; try { url = new URL(value); } catch { insist(false, 'invalid_remote', 'Use a credential-free HTTPS or SSH Git remote.', 400); }
    insist((url.protocol === 'https:' || url.protocol === 'ssh:') && url.hostname && url.pathname.length > 1 && !url.password && !url.search && !url.hash && (url.protocol !== 'https:' || !url.username), 'invalid_remote', 'Use a credential-free HTTPS or SSH Git remote.', 400);
    insist(!url.hostname.startsWith('-') && (!url.username || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(url.username)), 'invalid_remote', 'The Git remote must specify a valid SSH username and host.', 400);
    return url.toString();
}
function changedEntry(before: Entries[string] | undefined, after: Entries[string] | undefined) { return before?.oid !== after?.oid || before?.mode !== after?.mode; }
function editable(tree: SyncTree, path: string) { return Object.hasOwn(tree.files, path) && ['100644', '100755'].includes(tree.entries[path]?.mode); }
function invalidate(s: State, run: SyncRun, leases: Lease[], reason: string) {
    if (!leases.length) return;
    const removed = new Set(leases.map(lease => lease.id));
    s.leases = s.leases.filter(lease => !removed.has(lease.id));
    for (const journey of new Set(leases.map(lease => lease.journey))) {
        for (const review of s.journeys.find(j => j.id === journey)?.reviews ?? []) if (review.kind === 'approve') review.resolved = true;
        emit(s, 'lock.invalidated', 'git-sync', { runId: run.id, reason, locks: leases.filter(lease => lease.journey === journey).map(({ id, generation, path }) => ({ id, generation, path })), note: 'Wait for sync to finish, then reconcile and acquire new locks.' }, journey, [journey]);
    }
}
export function configureSync(s: State, input: { remote: unknown; branch: unknown; enabled: unknown }, user: Reviewer) {
    syncOwner(user); assertSyncWritable(s);
    insist(!s.importSession, 'import_in_progress', 'Finish the initial import before configuring sync.');
    insist(typeof input.enabled === 'boolean', 'invalid_sync', 'Enabled must be a boolean.', 400);
    const remote = remoteAddress(input.remote), branch = branchName(input.branch);
    const previous = s.sync, sameTarget = previous?.remote === remote && previous.branch === branch;
    s.sync = { ...(sameTarget ? previous : { backupRefs: previous?.backupRefs, receipts: previous?.receipts }), remote, branch, enabled: input.enabled, status: 'idle', updatedAt: Date.now() };
    delete s.sync.error;
    emit(s, 'sync.configured', user.id, { remote, branch, enabled: input.enabled });
    return s.sync;
}
function expectedTarget(sync: SyncState, input: { expectedRemote: unknown; expectedBranch: unknown }) {
    insist(input.expectedRemote === sync.remote && input.expectedBranch === sync.branch, 'sync_target_changed', 'The configured remote changed. Fetch the current settings before syncing.');
}
export function observeSync(s: State, input: { head: unknown; expectedRemote: unknown; expectedBranch: unknown }, user: Reviewer) {
    syncRunner(user); assertSyncWritable(s);
    insist(s.sync?.enabled, 'sync_disabled', 'Configure and enable Git sync first.');
    expectedTarget(s.sync, input);
    insist(oid(input.head) === s.head, 'stale_sync', 'Journey main changed. Fetch both heads again.');
    s.sync.lastCheckedAt = Date.now(); s.sync.lastSyncedHead = s.head; s.sync.lastRemoteHead = s.head;
    s.sync.status = 'idle'; delete s.sync.error;
    return { head: s.head, lastCheckedAt: s.sync.lastCheckedAt };
}
export function beginSync(s: State, input: { runId: unknown; expectedHead: unknown; remoteHead: unknown; expectedRemote: unknown; expectedBranch: unknown }, user: Reviewer) {
    syncRunner(user);
    const sync = s.sync;
    insist(sync?.enabled, 'sync_disabled', 'Configure and enable Git sync first.');
    expectedTarget(sync, input);
    insist(typeof input.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(input.runId), 'invalid_run', 'Use a unique sync run ID of 8–80 letters, numbers, underscores or hyphens.', 400);
    const expectedHead = oid(input.expectedHead), remoteHead = input.remoteHead === null ? null : oid(input.remoteHead);
    const receipt = syncReceipt(s, input.runId, user);
    if (receipt) {
        insist(receipt.journeyHead === expectedHead && receipt.remoteHead === remoteHead, 'idempotency_conflict', 'This sync run ID belongs to different heads.');
        return receipt;
    }
    if (sync.run) {
        const run = currentSyncRun(s, input.runId, user);
        insist(run.journeyHead === expectedHead && run.remoteHead === remoteHead, 'idempotency_conflict', 'This sync run ID belongs to different heads.');
        return run;
    }
    insist(!s.importSession, 'import_in_progress', 'Finish the initial import before syncing.');
    insist(s.head === expectedHead, 'stale_sync', 'Journey main changed. Fetch both heads again.');
    const run: SyncRun = { id: input.runId, actor: user.id, journeyHead: s.head, remoteHead, phase: 'preparing', conflictBranch: 'journey-conflicts/' + input.runId };
    sync.run = run; sync.status = 'running'; sync.updatedAt = Date.now(); delete sync.error;
    sync.backupRefs ??= {};
    sync.backupRefs[`refs/heads/journey-sync/${run.id}/original`] = run.journeyHead;
    emit(s, 'sync.started', user.id, { runId: run.id, journeyHead: run.journeyHead, remoteHead });
    return run;
}
export function syncReceipt(s: State, id: unknown, user: Reviewer) {
    syncRunner(user);
    const receipts = s.sync?.receipts;
    const receipt = typeof id === 'string' && receipts && Object.hasOwn(receipts, id) ? receipts[id] : undefined;
    if (receipt) insist(!user.agent || receipt.actor === user.id, 'sync_run_owned', 'Another coordinator owns this sync run.', 403);
    return receipt;
}
export function currentSyncRun(s: State, id: unknown, user: Reviewer) {
    syncRunner(user);
    const run = s.sync?.run;
    insist(run && typeof id === 'string' && run.id === id, 'sync_run_changed', 'The sync run changed. Read its current state before continuing.');
    insist(!user.agent || run.actor === user.id, 'sync_run_owned', 'Another coordinator owns this sync run.', 403);
    insist(s.head === run.journeyHead, 'stale_sync', 'Journey main changed during sync. Recovery is required.');
    return run;
}
export function prepareSync(s: State, run: SyncRun, base: string | null, original: SyncTree, incoming: SyncTree | null, common: SyncTree | null) {
    insist(run.phase === 'preparing', 'invalid_sync_phase', 'This run is no longer preparing.');
    if (run.prepared) { insist(run.base === base, 'idempotency_conflict', 'This run was prepared with another base.'); return run; }
    const revoked = incoming ? s.leases.filter(lease => {
        const path = lease.path;
        if (common && !changedEntry(common.entries[path], incoming.entries[path])) return false;
        if (!common && !changedEntry(original.entries[path], incoming.entries[path])) return false;
        if (lease.whole || !common || !editable(common, path) || !editable(incoming, path) || !editable(original, path) || common.entries[path].mode !== incoming.entries[path].mode) return true;
        try {
            const journeyChanges = diff(common.files[path], original.files[path]);
            return diff(common.files[path], incoming.files[path]).some(hunk => {
                const [start, end] = remap(hunk.start, hunk.start + hunk.count, journeyChanges);
                return touches(lease.canonicalStart, lease.canonicalEnd, { ...hunk, start, count: end - start });
            });
        } catch { return true; }
    }) : [];
    invalidate(s, run, revoked, 'Remote changes affect these reservations.');
    run.base = base; run.prepared = true;
    s.sync!.status = 'running'; s.sync!.updatedAt = Date.now(); delete s.sync!.error;
    if (run.remoteHead) s.sync!.backupRefs![`refs/heads/journey-sync/${run.id}/remote`] = run.remoteHead;
    return run;
}
export function stageSync(s: State, run: SyncRun, head: string, rewrites: Record<string, string | null>) {
    insist(run.phase === 'resolving' || run.prepared, 'sync_not_prepared', 'Prepare remote changes before staging a result.');
    insist(run.phase !== 'conflict', 'sync_conflict', 'The owner must choose a resolved remote head first.');
    if (run.phase === 'resolving') insist(head === run.resolutionHead, 'resolution_changed', 'Stage the exact resolved head selected by the owner.');
    if (run.candidate) {
        insist(run.candidate === head && JSON.stringify(run.rewrites ?? {}) === JSON.stringify(rewrites), 'idempotency_conflict', 'A different result is already staged for this run.');
        return run;
    }
    run.candidate = head; run.rewrites = rewrites;
    if (run.phase !== 'resolving') run.phase = 'publishing';
    s.sync!.backupRefs![`refs/heads/journey-sync/${run.id}/candidate`] = head;
    s.sync!.status = 'running'; s.sync!.updatedAt = Date.now(); delete s.sync!.error;
    return run;
}
export function completeSync(s: State, run: SyncRun, before: SyncTree, after: SyncTree, meta: State['revisions'][string]) {
    insist(run.candidate && (run.phase === 'publishing' || run.phase === 'resolving'), 'sync_not_staged', 'Stage and publish the exact result before completing sync.');
    const sync = s.sync!, head = run.candidate;
    if (head !== s.head) {
        const revoked: Lease[] = [];
        for (const lease of s.leases) {
            const path = lease.path;
            if (!changedEntry(before.entries[path], after.entries[path])) continue;
            if (lease.whole || !editable(before, path) || !editable(after, path) || before.entries[path].mode !== after.entries[path].mode) { revoked.push(lease); continue; }
            try { [lease.canonicalStart, lease.canonicalEnd] = remap(lease.canonicalStart, lease.canonicalEnd, diff(before.files[path], after.files[path])); }
            catch { revoked.push(lease); }
        }
        invalidate(s, run, revoked, 'The synchronized result changed these reservations.');
        s.revisions[head] = meta;
        const previous = s.head; s.head = head;
        for (const journey of s.journeys) if (journey.status === 'working' || journey.status === 'review') for (const review of journey.reviews) if (review.kind === 'approve') review.resolved = true;
        const event = emit(s, 'repository.synced', run.actor, { runId: run.id, revision: head, previous, remoteHead: run.remoteHead, rewrites: run.rewrites ?? {}, external: true, note: 'Remote Git changes bypassed Journey review. Reconcile this update and reacquire any invalidated locks.' });
        s.integrationCursor = event.id;
        notifyWaiters(s);
    }
    sync.lastSyncedHead = head; sync.lastRemoteHead = head; sync.lastRunId = run.id; sync.lastCompletedHead = head;
    sync.lastCheckedAt = Date.now();
    sync.receipts ??= {};
    sync.receipts[run.id] = { actor: run.actor, journeyHead: run.journeyHead, remoteHead: run.remoteHead, completed: true, head };
    sync.status = 'idle'; sync.updatedAt = Date.now(); delete sync.run; delete sync.error;
    return { completed: true, head, runId: run.id };
}
export function conflictSync(s: State, run: SyncRun, files: string[], reason: SyncRun['conflictReason'] = 'rebase_conflict') {
    insist(run.phase === 'preparing' || run.phase === 'conflict', 'invalid_sync_phase', 'A staged result cannot become a rebase conflict.');
    run.phase = 'conflict'; run.conflicts = files; run.conflictReason = reason;
    s.sync!.status = 'conflict'; s.sync!.updatedAt = Date.now();
    return run;
}
export function failSync(s: State, run: SyncRun) {
    s.sync!.status = 'error'; s.sync!.error = 'Git sync could not finish. The repository remains paused; inspect the runner and retry this run.'; s.sync!.updatedAt = Date.now();
    return run;
}
export function resolveSync(s: State, run: SyncRun, head: string, user: Reviewer) {
    syncOwner(user);
    insist(run.phase === 'conflict' || run.phase === 'resolving', 'invalid_sync_phase', 'Resolve an active conflict using the manually resolved remote main.');
    if (run.resolutionHead === head) return run;
    if (run.candidate) s.sync!.backupRefs![`refs/heads/journey-sync/${run.id}/resolution-${run.candidate}`] = run.candidate;
    run.resolutionHead = head; run.phase = 'resolving'; delete run.candidate; delete run.rewrites;
    s.sync!.status = 'running'; s.sync!.updatedAt = Date.now(); delete s.sync!.error;
    return run;
}
export function restartSync(s: State, run: SyncRun, observedRemoteHead: string) {
    insist(run.phase === 'preparing' || run.phase === 'publishing', 'invalid_sync_phase', 'Conflicts require explicit owner resolution.');
    insist(observedRemoteHead !== run.remoteHead && observedRemoteHead !== run.candidate, 'sync_retry_required', 'Retry the staged result or complete it when the remote already contains it.');
    s.sync!.backupRefs![`refs/heads/journey-sync/${run.id}/changed-remote`] = observedRemoteHead;
    emit(s, 'sync.restarted', run.actor, { runId: run.id, journeyHead: run.journeyHead, candidate: run.candidate, observedRemoteHead });
    s.sync!.receipts ??= {};
    s.sync!.receipts![run.id] = { actor: run.actor, journeyHead: run.journeyHead, remoteHead: run.remoteHead, restarted: true, head: s.head };
    s.sync!.status = 'idle'; s.sync!.updatedAt = Date.now(); delete s.sync!.run; delete s.sync!.error;
    return { restarted: true, head: s.head };
}
