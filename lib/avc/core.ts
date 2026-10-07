import { syncView } from './sync-view.ts';
import type { SyncState } from './sync.ts';
export type Files = Record<string, string>;
export type Hunk = {
    start: number;
    count: number;
    lines: string[];
};
export type Scope = {
    path: string;
    start: number;
    end: number;
    whole?: boolean;
};
export type Lease = Scope & {
    id: string;
    token: string;
    generation: number;
    journey: string;
    changeset: string;
    revision: string;
    anchorRevision?: string;
    anchorStart?: number;
    anchorEnd?: number;
    canonicalStart: number;
    canonicalEnd: number;
    expires: number;
    retained?: boolean;
};
export type BreakingChange = {
    target: string;
    kind: string;
    before: string;
    after: string;
    migration: string;
};
export type Patch = {
    id: string;
    description: string;
    before: string;
    after: string;
    actor: string;
    at: number;
    changes: {
        path: string;
        hunks: Hunk[];
    }[];
};
export type Changeset = {
    id: string;
    description: string;
    patches: Patch[];
};
export type Review = {
    id: string;
    actor: string;
    body: string;
    kind: 'comment' | 'request_changes' | 'approve';
    revision: string;
    changeset?: string;
    patch?: string;
    anchor?: { path: string; side: 'before' | 'after'; line: number; context: string };
    at: number;
    resolved?: boolean;
    authority?: 'human' | 'coordinator';
};
export type Journey = {
    id: string;
    title: string;
    description: string;
    actor: string;
    actorRole?: 'human' | 'worker' | 'coordinator';
    status: 'working' | 'review' | 'integrated' | 'abandoned';
    posted?: boolean;
    base: string;
    head: string;
    reconciledHead: string;
    reconciledCursor: number;
    changesets: Changeset[];
    manifest: BreakingChange[];
    manifestDeclared: boolean;
    reviews: Review[];
    dispositions: Record<string, string>;
    created: number;
    integratedRevision?: string;
};
export type Event = {
    id: number;
    type: string;
    at: number;
    journey?: string;
    targets: string[];
    actor: string;
    data: Record<string, unknown>;
};
export type Waiting = {
    id: string;
    journey: string;
    changeset: string;
    scopes: Scope[];
    revision: string;
    actor: string;
    at: number;
};
export type State = {
    id: string;
    name: string;
    head: string;
    revisions: Record<string, {
        parent?: string;
        message: string;
        actor: string;
        at: number;
    }>;
    journeys: Journey[];
    leases: Lease[];
    waiting: Waiting[];
    events: Event[];
    sequence: number;
    integrationCursor: number;
    generation: number;
    receipts: Record<string, unknown>;
    requireApproval: boolean;
    allowWorkerMerge?: boolean;
    allowCoordinatorApproval?: boolean;
    importSession?: { id: string; actor: string; started: number };
    imported?: { session: string; head: string; refs: Record<string, string>; objectCount: number; at: number };
    sync?: SyncState;
};
export class ProtocolError extends Error {
    status: number;
    code: string;
    details: unknown;
    constructor(code: string, message: string, status = 409, details?: unknown) { super(message); this.status = status; this.code = code; this.details = details; }
}
export function insist(ok: unknown, code: string, message: string, status = 409, details?: unknown): asserts ok { if (!ok)
    throw new ProtocolError(code, message, status, details); }
export const lines = (s: string) => s === '' ? [] : s.split('\n');
export function diff(before: string, after: string): Hunk[] {
    const a = lines(before), b = lines(after);
    if (before === after)
        return [];
    // Bound quadratic work for large files. The conservative hunk may require a wider lock.
    if (a.length * b.length > 2_250_000) {
        let start = 0, endA = a.length, endB = b.length;
        while (start < endA && start < endB && a[start] === b[start]) start++;
        while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
        return [{ start, count: endA - start, lines: b.slice(start, endB) }];
    }
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: Hunk[] = [];
    let i = 0, j = 0, h: Hunk | undefined;
    const flush = () => { if (h) {
        out.push(h);
        h = undefined;
    } };
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            flush();
            i++;
            j++;
        }
        else {
            h ??= { start: i, count: 0, lines: [] };
            if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j]))
                h.lines.push(b[j++]);
            else {
                i++;
                h.count++;
            }
        }
    }
    flush();
    return out;
}
export function applyHunks(text: string, hunks: Hunk[]): string { let a = lines(text); for (const h of [...hunks].sort((x, y) => y.start - x.start))
    a = a.slice(0, h.start).concat(h.lines, a.slice(h.start + h.count)); return a.join('\n'); }
// Ranges use zero-based inclusive start, exclusive end internally. Insertions at either boundary conflict conservatively.
export function touches(start: number, end: number, h: Hunk) { return h.count === 0 ? h.start >= start && h.start <= end : h.start < end && h.start + h.count > start; }
export function remap(start: number, end: number, hunks: Hunk[], allowOwned = false): [
    number,
    number
] { let shift = 0, growth = 0; for (const h of hunks) {
    if (touches(start, end, h)) {
        insist(allowOwned, 'ambiguous_range', 'The anchored range changed. Refresh and request a new lock.');
        growth += h.lines.length - h.count;
    }
    else if (h.start + h.count <= start)
        shift += h.lines.length - h.count;
} return [start + shift, Math.max(start + shift, end + shift + growth)]; }
export function projectRange(start: number, end: number, hunks: Hunk[]): [
    number,
    number
] {
    function boundary(pos: number, isEnd: boolean) { let shift = 0; for (const h of hunks) {
        if (pos < h.start)
            return pos + shift;
        if (pos <= h.start + h.count)
            return h.start + shift + (isEnd ? h.lines.length : 0);
        shift += h.lines.length - h.count;
    } return pos + shift; }
    return [boundary(start, false), boundary(end, true)];
}
export function mergeFiles(base: Files, ours: Files, theirs: Files): Files { const merged: Files = Object.assign(Object.create(null), theirs); for (const path of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (base[path] === ours[path])
        continue;
    const h = diff(base[path] ?? '', ours[path] ?? ''), other = diff(base[path] ?? '', theirs[path] ?? '');
    const mapped = h.map(x => { const [start] = remap(x.start, x.start + x.count, other); return { ...x, start }; });
    if (ours[path] === undefined) {
        insist(base[path] === theirs[path], 'merge_conflict', `Concurrent changes to deleted file ${path}.`);
        delete merged[path];
    }
    else
        merged[path] = applyHunks(theirs[path] ?? '', mapped);
} return merged; }
export function emit(s: State, type: string, actor: string, data: Record<string, unknown>, journey?: string, targets?: string[]) { insist(s.events.length < 1800, 'event_capacity', 'This MVP repository has reached its event limit. Export it before continuing.', 413); const event = { id: ++s.sequence, type, actor, data, journey, at: Date.now(), targets: targets ?? s.journeys.filter(j => j.status !== 'integrated' && j.status !== 'abandoned' && j.id !== journey).map(j => j.id) }; s.events.push(event); return event; }
export const getJourney = (s: State, id: string) => { const j = s.journeys.find(x => x.id === id); insist(j, 'journey_not_found', 'Journey not found.', 404); return j; };
export function activeJourney(s: State, id: string) { const j = getJourney(s, id); insist(j.status === 'working' || j.status === 'review', 'journey_closed', 'This journey is closed.'); return j; }
// Keep a numeric deadline for older clients; retained is the authoritative lifetime marker.
export const retainedExpiry = 253402300799999;
export const leaseActive = (lease: Lease, now = Date.now()) => lease.retained === true || lease.expires > now;
export function normalizePostedLocks(s: State, now = Date.now()) {
    let changed = false;
    for (const j of s.journeys) {
        if (!j.posted && (j.status === 'review' || s.events.some(e => e.type === 'review.requested' && e.journey === j.id))) {
            j.posted = true;
            changed = true;
        }
        if (!j.posted || j.status === 'integrated' || j.status === 'abandoned') continue;
        for (const l of s.leases.filter(l => l.journey === j.id)) {
            // Already-expired transient grants must never be resurrected by legacy normalization.
            if (leaseActive(l, now) && (l.retained !== true || l.expires !== retainedExpiry)) {
                l.retained = true;
                l.expires = retainedExpiry;
                changed = true;
            }
        }
    }
    return changed;
}
export function expire(s: State, now = Date.now()) { normalizePostedLocks(s, now); const stale = s.leases.filter(l => !leaseActive(l, now)); s.leases = s.leases.filter(l => leaseActive(l, now)); for (const l of stale)
    emit(s, 'lock.expired', 'system', { lockId: l.id, generation: l.generation }, l.journey, [l.journey]); if (stale.length)
    notifyWaiters(s); }
export function notifyWaiters(s: State) { for (const w of s.waiting)
    emit(s, 'lock.available', 'system', { requestId: w.id, note: 'Retry acquisition; availability is not a grant.' }, undefined, [w.journey]); }
export function overlap(a: {
    start: number;
    end: number;
}, b: {
    start: number;
    end: number;
}) { return a.start <= b.end && b.start <= a.end; }
export function acquire(s: State, j: Journey, changeset: string, scopes: Scope[], revision: string, source: Files, canonical: Files, actor: string, now = Date.now(), journeyFiles: Files = source) {
    normalizePostedLocks(s, now);
    insist(j.changesets.some(c => c.id === changeset), 'changeset_not_found', 'Create a changeset before acquiring locks.', 404);
    insist(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 20, 'invalid_scopes', 'Supply 1–20 lock scopes.', 400);
    const mapped = scopes.map(scope => { insist(scope.path && Number.isInteger(scope.start) && Number.isInteger(scope.end) && scope.start >= 1 && scope.end >= scope.start, 'invalid_range', 'Ranges must use inclusive positive line numbers.', 400); insist(Object.hasOwn(source, scope.path) || scope.whole, 'file_not_found', 'Use a whole-file lock to create a new file.', 404); const size = Math.max(1, lines(source[scope.path] ?? '').length); insist(scope.whole || scope.end <= size, 'invalid_range', 'The range exceeds the file length.', 400); const start = scope.whole ? 0 : scope.start - 1, end = scope.whole ? size : scope.end; const [cs, ce] = scope.whole ? [0, Math.max(1, lines(canonical[scope.path] ?? '').length)] : projectRange(start, end, diff(source[scope.path] ?? '', canonical[scope.path] ?? '')); const [ws, we] = scope.whole ? [0, Math.max(1, lines(journeyFiles[scope.path] ?? '').length)] : projectRange(start, end, diff(source[scope.path] ?? '', journeyFiles[scope.path] ?? '')); return { ...scope, start: ws + 1, end: Math.max(ws + 1, we), anchorRevision: revision, anchorStart: scope.start, anchorEnd: scope.end, canonicalStart: cs, canonicalEnd: ce }; });
    const conflicts = s.leases.filter(l => leaseActive(l, now) && l.journey !== j.id && mapped.some(m => m.path === l.path && (m.whole || l.whole || overlap({ start: m.canonicalStart, end: m.canonicalEnd }, { start: l.canonicalStart, end: l.canonicalEnd }))));
    if (conflicts.length) {
        insist(!s.leases.some(l => l.journey === j.id && leaseActive(l, now)), 'would_deadlock', 'Cannot wait for additional conflicting scopes while holding locks. Wait for the other journey to integrate or be abandoned, or abandon this journey to release its holds.', 409, { conflicts });
        let w = s.waiting.find(w => w.journey === j.id && w.changeset === changeset);
        if (!w) {
            w = { id: crypto.randomUUID(), journey: j.id, changeset, scopes: structuredClone(scopes), revision, actor, at: now };
            s.waiting.push(w);
            emit(s, 'lock.queued', actor, { requestId: w.id, conflicts: conflicts.map(l => l.id) }, j.id, [j.id]);
        }
        else if (w.revision !== revision || JSON.stringify(w.scopes) !== JSON.stringify(scopes)) {
            // One pending request per changeset. A retry may target a newer revision
            // or different scopes; keep its identity and queue age, not stale ranges.
            w.scopes = structuredClone(scopes);
            w.revision = revision;
            w.actor = actor;
            emit(s, 'lock.queue_updated', actor, { requestId: w.id, conflicts: conflicts.map(l => l.id) }, j.id, [j.id]);
        }
        return { queued: true, requestId: w.id, conflicts };
    }
    // Override any caller-supplied retained property with the trusted Journey history.
    const leases = mapped.map(m => ({ ...m, id: crypto.randomUUID(), token: crypto.randomUUID(), generation: ++s.generation, journey: j.id, changeset, revision, retained: j.posted ? true : undefined, expires: j.posted ? retainedExpiry : now + 600000 }));
    s.leases.push(...leases);
    const requestId = s.waiting.find(w => w.journey === j.id && w.changeset === changeset)?.id;
    s.waiting = s.waiting.filter(w => w.journey !== j.id || w.changeset !== changeset);
    emit(s, 'lock.granted', actor, { ...(requestId ? { requestId } : {}), locks: leases.map(l => ({ id: l.id, generation: l.generation, path: l.path, start: l.start, end: l.end, expires: l.expires, ...(l.retained ? { retained: true } : {}) })) }, j.id, [j.id]);
    return { queued: false, locks: leases };
}
export function checkTokens(s: State, j: Journey, tokens: string[], now = Date.now()) { const held = s.leases.filter(l => l.journey === j.id); insist(held.length > 0, 'locks_required', 'Acquire valid locks for the published changes before submitting or integrating.'); insist(Array.isArray(tokens) && held.every(l => leaseActive(l, now) && tokens.includes(l.token)), 'invalid_lease', 'Return every current journey lock token. Expired or superseded tokens cannot publish.'); return held; }
export function recordPatch(s: State, j: Journey, changesetId: string, files: Files, before: Files, after: string, description: string, actor: string, tokens: string[], now = Date.now()) {
    const c = j.changesets.find(c => c.id === changesetId);
    insist(c, 'changeset_not_found', 'Changeset not found.', 404);
    const held = checkTokens(s, j, tokens, now);
    const changes = [...new Set([...Object.keys(before), ...Object.keys(files)])].filter(p => before[p] !== files[p]).map(path => ({ path, hunks: diff(before[path] ?? '', files[path] ?? '') }));
    insist(changes.length, 'empty_patch', 'The patch has no changes.', 400);
    for (const change of changes) {
        const scopes = held.filter(l => l.path === change.path && l.changeset === changesetId);
        if (Object.hasOwn(before, change.path) !== Object.hasOwn(files, change.path))
            insist(scopes.some(l => l.whole), 'whole_file_required', 'Creating or deleting a file requires a whole-file lock.');
        insist(scopes.some(l => l.whole) || change.hunks.every(h => scopes.some(l => h.start >= l.start - 1 && h.start + h.count <= l.end)), 'lock_coverage', `Patch changes unlocked lines in ${change.path}.`);
        for (const l of held.filter(l => l.path === change.path)) {
            const [start, end] = projectRange(l.start - 1, l.end, change.hunks);
            l.start = start + 1;
            l.end = end;
            l.revision = after;
        }
    }
    const patch: Patch = { id: crypto.randomUUID(), description, before: j.head, after, actor, at: now, changes };
    c.patches.push(patch);
    j.head = after;
    j.status = 'working';
    j.manifestDeclared = false;
    emit(s, 'patch.recorded', actor, { patchId: patch.id, changesetId: c.id, revision: after, description }, j.id, [j.id]);
    return patch;
}
export function isCanonicalUpdate(event: Pick<Event, 'type'>) { return event.type === 'journey.integrated' || event.type === 'repository.synced'; }
export function pendingIntegrations(s: State, j: Journey) { return s.events.filter(e => isCanonicalUpdate(e) && e.id > j.reconciledCursor && e.journey !== j.id); }
export function validateSubmission(s: State, j: Journey) { insist(j.changesets.some(c => c.patches.length), 'empty_journey', 'Record at least one patch.'); insist(j.manifestDeclared, 'manifest_required', 'Declare breaking changes, or explicitly declare none.'); insist(j.reconciledHead === s.head && j.reconciledCursor === s.integrationCursor, 'reconciliation_required', 'Reconcile intervening integrated journeys before submitting.', 409, { head: s.head, cursor: s.integrationCursor, events: pendingIntegrations(s, j) }); insist(!j.reviews.some(r => r.kind === 'request_changes' && !r.resolved), 'changes_requested', 'Resolve outstanding review requests first.'); }
// The route checks complete immutable diff coverage before retaining these actual grants.
export function submitForReview(s: State, j: Journey, revision: string, actor: string, tokens?: string[], now = Date.now()) {
    insist(revision === j.head, 'stale_revision', 'Submit the current journey revision.');
    validateSubmission(s, j);
    const held = checkTokens(s, j, tokens ?? s.leases.filter(l => l.journey === j.id).map(l => l.token), now);
    for (const l of held) { l.retained = true; l.expires = retainedExpiry; }
    j.posted = true;
    j.status = 'review';
    emit(s, 'review.requested', actor, { revision: j.head, title: j.title }, j.id, [j.id]);
    return { revision: j.head };
}
export function reconciliationPlan(s: State, j: Journey, dispositions?: Record<string, string>) {
    const pending = pendingIntegrations(s, j);
    for (const event of pending)
        insist(['unaffected', 'adapted', 'needs_review'].includes(dispositions?.[event.id] ?? ''), 'disposition_required', 'Provide a disposition for every pending integration.', 400);
    insist(!pending.some(event => dispositions?.[event.id] === 'needs_review'), 'needs_review', 'Resolve affected integrations before completing reconciliation.');
    return {
        current: j.reconciledHead === s.head && j.reconciledCursor === s.integrationCursor,
        unaffected: pending.every(event => dispositions?.[event.id] === 'unaffected'),
        dispositions: Object.fromEntries(pending.map(event => [event.id, dispositions![event.id]])),
    };
}
export function recordReconciliation(s: State, j: Journey, revision: string, dispositions: Record<string, string> | undefined, actor: string) {
    const plan = reconciliationPlan(s, j, dispositions);
    if (plan.current)
        return { revision: j.head, status: j.status, manifestDeclared: j.manifestDeclared, unchanged: true };
    const submitted = j.status === 'review' && j.manifestDeclared;
    j.head = revision;
    j.base = s.head;
    j.reconciledHead = s.head;
    j.reconciledCursor = s.integrationCursor;
    Object.assign(j.dispositions, plan.dispositions);
    j.status = submitted && plan.unaffected ? 'review' : 'working';
    if (!plan.unaffected)
        j.manifestDeclared = false;
    // An unaffected disposition retains submission, never approval of the earlier exact revision.
    for (const review of j.reviews)
        if (review.kind === 'approve')
            review.resolved = true;
    emit(s, 'journey.reconciled', actor, { revision, head: s.head, cursor: s.integrationCursor, dispositions: plan.dispositions }, j.id, [j.id]);
    return { revision, status: j.status, manifestDeclared: j.manifestDeclared };
}
export function finalizeIntegration(s: State, j: Journey, revision: string, actor: string, oldCanonical: Files, newCanonical: Files) {
    s.head = revision;
    j.status = 'integrated';
    j.integratedRevision = revision;
    s.leases = s.leases.filter(l => l.journey !== j.id);
    s.waiting = s.waiting.filter(w => w.journey !== j.id);
    for (const l of s.leases) {
        if (l.whole)
            continue;
        const [start, end] = remap(l.canonicalStart, l.canonicalEnd, diff(oldCanonical[l.path] ?? '', newCanonical[l.path] ?? ''));
        l.canonicalStart = start;
        l.canonicalEnd = end;
    }
    const event = emit(s, 'journey.integrated', actor, { revision, previous: j.reconciledHead, title: j.title, breakingChanges: j.manifest }, j.id);
    s.integrationCursor = event.id;
    notifyWaiters(s);
    return event;
}
export function publicState(s: State, actor: string, agent = false) { return { ...s, sync: s.sync ? syncView(s.sync) : undefined, ...repositoryPolicy(s), leases: s.leases.map(l => ({ ...l, token: !agent || s.journeys.find(j => j.id === l.journey)?.actor === actor ? l.token : undefined })), receipts: undefined }; }

export type Reviewer = { id: string; agent: boolean; role?: string };
export function repositoryPolicy(s: State) { return { requireApproval: s.requireApproval, allowWorkerMerge: s.allowWorkerMerge ?? true, allowCoordinatorApproval: s.allowCoordinatorApproval ?? false }; }
export function updatePolicy(s: State, input: Record<string, unknown>, user: Reviewer) {
    insist(!user.agent, 'forbidden', 'Only the repository owner can change settings.', 403);
    const fields = ['requireApproval', 'allowWorkerMerge', 'allowCoordinatorApproval'] as const;
    insist(fields.some(key => Object.hasOwn(input, key)), 'invalid_policy', 'Supply at least one repository setting.', 400);
    for (const key of fields) if (Object.hasOwn(input, key)) insist(typeof input[key] === 'boolean', 'invalid_policy', 'Repository settings must be booleans.', 400);
    for (const key of fields) if (Object.hasOwn(input, key)) s[key] = input[key] as boolean;
    if (input.allowCoordinatorApproval === false) for (const j of s.journeys) for (const r of j.reviews) if (r.authority === 'coordinator' && r.kind === 'approve') r.resolved = true;
    return repositoryPolicy(s);
}
export function workerJourney(j: Journey, legacyRoles: Record<string, string> = {}) { return j.actor.startsWith('agent:') && (j.actorRole ?? legacyRoles[j.actor]) === 'worker'; }
export function approvalAuthority(s: State, j: Journey, user: Reviewer, legacyRoles: Record<string, string> = {}): 'human' | 'coordinator' {
    if (!user.agent) return 'human';
    insist(user.role === 'coordinator', 'human_approval_required', 'Workers cannot approve journeys.', 403);
    insist(repositoryPolicy(s).allowCoordinatorApproval, 'coordinator_approval_disabled', 'The repository owner must allow coordinator approval in settings.', 403);
    insist(j.actor !== user.id, 'self_approval_denied', 'A coordinator cannot approve its own journey.', 403);
    insist(workerJourney(j, legacyRoles), 'worker_journey_required', 'Coordinators may approve only worker journeys.', 403);
    return 'coordinator';
}
export function hasApproval(s: State, j: Journey) { return j.reviews.some(r => r.kind === 'approve' && r.revision === j.head && !r.resolved && (r.authority !== 'coordinator' || repositoryPolicy(s).allowCoordinatorApproval)); }
export function validateIntegrationAuthority(s: State, j: Journey, user: Reviewer) {
    insist(!user.agent || repositoryPolicy(s).allowWorkerMerge, 'worker_merge_disabled', 'The repository owner has disabled worker merging.', 403);
    if (!user.agent || s.requireApproval) insist(hasApproval(s, j), 'approval_required', 'An authorized reviewer must approve this exact revision.');
}
const approvalEventTypes = new Set(['review.requested', 'review.approved', 'review.changes_requested', 'review.commented', 'review.resolved', 'patch.recorded', 'manifest.updated', 'journey.reconciled', 'journey.integrated', 'repository.synced', 'lock.invalidated', 'sync.started', 'sync.restarted', 'journey.abandoned', 'policy.changed']);
export function approvalInbox(s: State, user: Reviewer, since = 0, legacyRoles: Record<string, string> = {}) {
    insist(!user.agent || user.role === 'coordinator', 'forbidden', 'Only the repository owner or a coordinator can read the approval queue.', 403);
    insist(Number.isSafeInteger(since) && since >= 0, 'invalid_cursor', 'Invalid event cursor.', 400);
    const policy = repositoryPolicy(s), canApprove = !user.agent || policy.allowCoordinatorApproval;
    const queue = s.journeys.filter(j => j.status === 'review' && (!user.agent || (j.actor !== user.id && workerJourney(j, legacyRoles)))).map(j => {
        const reasons: string[] = [];
        try { validateSubmission(s, j); } catch (e) { if (!(e instanceof ProtocolError)) throw e; reasons.push(e.code); }
        const reviewable = reasons.length === 0, approved = hasApproval(s, j);
        if (approved) reasons.push('approval_already_granted');
        if (!canApprove) reasons.push('coordinator_approval_disabled');
        return { journey: j.id, title: j.title, actor: j.actor, revision: j.head, reconciledHead: j.reconciledHead, reconciledCursor: j.reconciledCursor, reviewable, approved, ready: reviewable && !approved && canApprove, reasons };
    });
    return { policy, canApprove, head: s.head, integrationCursor: s.integrationCursor, cursor: s.sequence, queue, ready: queue.filter(j => j.ready), events: s.events.filter(e => e.id > since && approvalEventTypes.has(e.type)) };
}
