import { diff, leaseActive, lines, overlap, projectRange, touches, type Files, type Hunk, type Journey, type State, type Waiting } from './core.ts';

export type LiveRegion = {
    /** One-based, inclusive coordinates in the snapshot's canonical main revision. */
    start: number;
    end: number;
    status: 'locked' | 'waiting' | 'contended';
    lockIds: string[];
    waitingIds: string[];
    changesetIds: string[];
    approximate: boolean;
};
export type LiveHeldLock = { id: string; journey: string; changeset: string; conflictingRequestIds: string[] };
export type LiveFile = {
    path: string;
    lineCount: number;
    exists: boolean;
    regions: LiveRegion[];
    heldLocks: LiveHeldLock[];
    /** Unique held locks currently blocking at least one other journey's request. */
    conflictCount: number;
    lockCount: number;
    waitingCount: number;
    /** Last recorded patch or lock activity, never the snapshot polling time. Zero means unknown. */
    updatedAt: number;
};
export type LiveChangeset = {
    id: string;
    journey: string;
    title: string;
    description: string;
    status: Journey['status'];
    paths: string[];
    lockCount: number;
    waitingCount: number;
    patchCount: number;
};
export type LiveSnapshot = {
    head: string;
    sequence: number;
    updatedAt: number;
    files: LiveFile[];
    changesets: LiveChangeset[];
    summary: { fileCount: number; lockedRegions: number; waitingCount: number; contendedRegions: number };
};

type Overlay = { start: number; end: number; lock?: string; waiting?: string; changeset: string; approximate: boolean };
const unique = (values: string[]) => [...new Set(values)].sort();
const content = (files: Files, path: string) => Object.hasOwn(files, path) ? files[path] : '';

/** Split at actual line boundaries; conservative lock conflicts do not imply shared lines. */
function regions(overlays: Overlay[]): LiveRegion[] {
    const boundaries = new Map<number, { add: Overlay[]; remove: Overlay[] }>();
    const boundary = (at: number) => {
        let entry = boundaries.get(at);
        if (!entry) { entry = { add: [], remove: [] }; boundaries.set(at, entry); }
        return entry;
    };
    for (const overlay of overlays) {
        boundary(overlay.start).add.push(overlay);
        boundary(overlay.end + 1).remove.push(overlay);
    }
    const points = [...boundaries.keys()].sort((a, b) => a - b), active = new Set<Overlay>(), result: LiveRegion[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const point = points[i], entry = boundaries.get(point)!;
        entry.remove.forEach(overlay => active.delete(overlay));
        entry.add.forEach(overlay => active.add(overlay));
        if (!active.size) continue;
        const current = [...active];
        const lockIds = unique(current.flatMap(overlay => overlay.lock ? [overlay.lock] : []));
        const waitingIds = unique(current.flatMap(overlay => overlay.waiting ? [overlay.waiting] : []));
        const region: LiveRegion = {
            start: point, end: points[i + 1] - 1,
            status: waitingIds.length > 1 ? 'contended' : waitingIds.length === 1 ? 'waiting' : 'locked',
            lockIds, waitingIds, changesetIds: unique(current.map(overlay => overlay.changeset)),
            approximate: current.some(overlay => overlay.approximate),
        };
        const previous = result.at(-1);
        if (previous && previous.end + 1 === region.start && previous.status === region.status && previous.approximate === region.approximate
            && JSON.stringify(previous.lockIds) === JSON.stringify(lockIds) && JSON.stringify(previous.waitingIds) === JSON.stringify(waitingIds)
            && JSON.stringify(previous.changesetIds) === JSON.stringify(region.changesetIds)) previous.end = region.end;
        else result.push(region);
    }
    return result;
}

/** Read immutable Git revisions against one captured state. Never expose tokens or code contents. */
export async function liveSnapshot(state: State, readFiles: (revision: string) => Promise<Files>, now = Date.now()): Promise<LiveSnapshot> {
    const canonical = await readFiles(state.head);
    const files = new Map<string, LiveFile>(), overlays = new Map<string, Overlay[]>();
    const file = (path: string) => {
        let value = files.get(path);
        if (!value) {
            value = { path, lineCount: Math.max(1, lines(content(canonical, path)).length), exists: Object.hasOwn(canonical, path), regions: [], heldLocks: [], conflictCount: 0, lockCount: 0, waitingCount: 0, updatedAt: 0 };
            files.set(path, value);
        }
        return value;
    };
    Object.keys(canonical).forEach(file);
    const changesets = new Map<string, LiveChangeset>();
    const pathSets = new Map<string, Set<string>>(), lockSets = new Map<string, Set<string>>(), waitingSets = new Map<string, Set<string>>();
    const activeJourneys = new Set(state.journeys.filter(journey => journey.status === 'working' || journey.status === 'review').map(journey => journey.id));
    for (const journey of state.journeys) for (const changeset of journey.changesets) {
        const paths = new Set(changeset.patches.flatMap(patch => patch.changes.map(change => change.path)));
        paths.forEach(file);
        for (const patch of changeset.patches) for (const change of patch.changes) {
            const entry = file(change.path);
            entry.updatedAt = Math.max(entry.updatedAt, patch.at ?? 0);
        }
        pathSets.set(changeset.id, paths); lockSets.set(changeset.id, new Set()); waitingSets.set(changeset.id, new Set());
        changesets.set(changeset.id, {
            id: changeset.id, journey: journey.id, title: journey.title, description: changeset.description, status: journey.status,
            paths: [], lockCount: 0, waitingCount: 0, patchCount: changeset.patches.length,
        });
    }
    const add = (path: string, start: number, end: number, overlay: Omit<Overlay, 'start' | 'end'>) => {
        const current = file(path), size = current.lineCount;
        // Deleted/inserted regions collapse to the nearest visible line. Missing files
        // receive one virtual row, rather than silently disappearing from the map.
        const first = Math.max(1, Math.min(size, start + 1)), last = Math.max(first, Math.min(size, end));
        const values = overlays.get(path) ?? [];
        values.push({ ...overlay, approximate: overlay.approximate || end <= start || start < 0 || end > size || start >= size, start: first, end: last }); overlays.set(path, values);
        pathSets.get(overlay.changeset)?.add(path);
        if (overlay.lock) lockSets.get(overlay.changeset)?.add(overlay.lock);
        if (overlay.waiting) waitingSets.get(overlay.changeset)?.add(overlay.waiting);
    };
    const activeLeases = state.leases.filter(lease => activeJourneys.has(lease.journey) && leaseActive(lease, now) && changesets.get(lease.changeset)?.journey === lease.journey);
    const leasesByPath = new Map<string, typeof activeLeases>();
    const heldById = new Map<string, LiveHeldLock>();
    for (const lease of activeLeases) {
        if (heldById.has(lease.id)) continue;
        const held = { id: lease.id, journey: lease.journey, changeset: lease.changeset, conflictingRequestIds: [] as string[] };
        file(lease.path).heldLocks.push(held); heldById.set(lease.id, held);
        const pathLeases = leasesByPath.get(lease.path) ?? [];
        pathLeases.push(lease); leasesByPath.set(lease.path, pathLeases);
        add(lease.path, lease.whole ? 0 : lease.canonicalStart, lease.whole ? file(lease.path).lineCount : lease.canonicalEnd,
            { lock: lease.id, changeset: lease.changeset, approximate: !lease.whole && !Object.hasOwn(canonical, lease.path) });
    }
    // Grouping caches each source revision's load and each file diff for this request,
    // while keeping at most canonical + one source snapshot in memory. Reads are serial.
    const byRevision = new Map<string, Waiting[]>(), waitingIds = new Set<string>();
    for (const waiting of state.waiting) {
        if (!activeJourneys.has(waiting.journey) || changesets.get(waiting.changeset)?.journey !== waiting.journey || waitingIds.has(waiting.id)) continue;
        waitingIds.add(waiting.id);
        const group = byRevision.get(waiting.revision) ?? [];
        group.push(waiting); byRevision.set(waiting.revision, group);
    }
    for (const [revision, group] of byRevision) {
        // Whole-file requests require no historical content to project.
        const source = revision === state.head ? canonical : group.some(waiting => waiting.scopes.some(scope => !scope.whole)) ? await readFiles(revision) : {};
        const diffs = new Map<string, Hunk[]>();
        for (const waiting of group) for (const scope of waiting.scopes) {
            let start = 0, end = file(scope.path).lineCount, approximate = false;
            if (!scope.whole) {
                let hunks = diffs.get(scope.path);
                if (!hunks) { hunks = diff(content(source, scope.path), content(canonical, scope.path)); diffs.set(scope.path, hunks); }
                [start, end] = projectRange(scope.start - 1, scope.end, hunks);
                approximate = !Object.hasOwn(source, scope.path) || !Object.hasOwn(canonical, scope.path) || hunks.some(hunk => touches(scope.start - 1, scope.end, hunk));
            }
            // Use the same conservative canonical boundary rule as acquisition. Visual
            // regions alone cannot identify conflicts (adjacent scopes can block).
            for (const lease of leasesByPath.get(scope.path) ?? []) {
                if (lease.journey !== waiting.journey && (scope.whole || lease.whole || overlap({ start, end }, { start: lease.canonicalStart, end: lease.canonicalEnd }))) {
                    const requests = heldById.get(lease.id)!.conflictingRequestIds;
                    if (!requests.includes(waiting.id)) requests.push(waiting.id);
                }
            }
            file(scope.path).updatedAt = Math.max(file(scope.path).updatedAt, waiting.at);
            add(scope.path, start, end, { waiting: waiting.id, changeset: waiting.changeset, approximate });
        }
    }
    for (const [path, values] of overlays) file(path).regions = regions(values);
    for (const changeset of changesets.values()) {
        changeset.paths = [...pathSets.get(changeset.id)!].sort();
        changeset.lockCount = lockSets.get(changeset.id)!.size;
        changeset.waitingCount = waitingSets.get(changeset.id)!.size;
    }
    // Grant history also identifies released locks, which no longer exist in state.leases.
    // Do not use expiry deadlines or refresh time as a file's activity timestamp.
    const lockPaths = new Map(state.leases.map(lease => [lease.id, lease.path]));
    const journeyLockPaths = new Map<string, Set<string>>();
    for (const event of state.events) {
        if (!['lock.granted', 'lock.invalidated'].includes(event.type) || !Array.isArray(event.data.locks)) continue;
        for (const value of event.data.locks) {
            if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.path !== 'string') continue;
            lockPaths.set(value.id, value.path);
            if (event.journey) {
                const paths = journeyLockPaths.get(event.journey) ?? new Set<string>();
                paths.add(value.path); journeyLockPaths.set(event.journey, paths);
            }
        }
    }
    const latestQueueUpdate = new Map<string, number>();
    for (const event of state.events) if (event.type === 'lock.queue_updated' || event.type === 'lock.queued') latestQueueUpdate.set(String(event.data.requestId), event.id);
    const waitingById = new Map(state.waiting.map(waiting => [waiting.id, waiting]));
    const touch = (path: string, at: number) => { const entry = files.get(path); if (entry) entry.updatedAt = Math.max(entry.updatedAt, at); };
    const queuedPaths = new Map<string, { journey?: string; paths: Set<string> }>();
    for (const event of state.events) {
        if (['lock.granted', 'lock.invalidated'].includes(event.type) && Array.isArray(event.data.locks)) {
            for (const value of event.data.locks) if (value && typeof value === 'object' && typeof value.path === 'string') touch(value.path, event.at);
            if (event.type === 'lock.granted' && typeof event.data.requestId === 'string') {
                // A successful retry can move to an unblocked file and consume its old
                // request. Other changesets in the same journey may still be queued.
                for (const path of queuedPaths.get(event.data.requestId)?.paths ?? []) touch(path, event.at);
                queuedPaths.delete(event.data.requestId);
            }
        } else if (event.type === 'lock.expired' && typeof event.data.lockId === 'string') {
            const path = lockPaths.get(event.data.lockId); if (path) touch(path, event.at);
        } else if (event.type === 'lock.queued' || event.type === 'lock.queue_updated') {
            const requestId = String(event.data.requestId);
            const waiting = waitingById.get(requestId);
            // Moving a request changes the old blockers' activity too.
            for (const path of queuedPaths.get(requestId)?.paths ?? []) touch(path, event.at);
            const requestPaths = new Set<string>();
            // The original queue event predates replacement scopes; use only the newest
            // request update for those scopes. Blocker paths remain historically exact.
            if (waiting && latestQueueUpdate.get(String(event.data.requestId)) === event.id) {
                for (const scope of waiting.scopes) { touch(scope.path, event.at); requestPaths.add(scope.path); }
            }
            if (Array.isArray(event.data.conflicts)) for (const id of event.data.conflicts) {
                const path = lockPaths.get(String(id)); if (path) { touch(path, event.at); requestPaths.add(path); }
            }
            queuedPaths.set(requestId, { journey: event.journey, paths: requestPaths });
        } else if (event.journey && ['journey.integrated', 'journey.abandoned', 'review.requested'].includes(event.type)) {
            for (const path of journeyLockPaths.get(event.journey) ?? []) touch(path, event.at);
            if (event.type !== 'review.requested') for (const [id, queued] of queuedPaths) {
                if (queued.journey === event.journey) {
                    for (const path of queued.paths) touch(path, event.at);
                    queuedPaths.delete(id);
                }
            }
        }
    }
    for (const entry of files.values()) {
        entry.heldLocks.sort((a, b) => a.id.localeCompare(b.id));
        entry.heldLocks.forEach(held => held.conflictingRequestIds.sort());
        entry.lockCount = entry.heldLocks.length;
        entry.conflictCount = entry.heldLocks.filter(held => held.conflictingRequestIds.length > 0).length;
        entry.waitingCount = new Set(entry.regions.flatMap(region => region.waitingIds)).size;
    }
    const resultFiles = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    return {
        head: state.head, sequence: state.sequence, updatedAt: now, files: resultFiles, changesets: [...changesets.values()],
        summary: {
            fileCount: resultFiles.length,
            lockedRegions: resultFiles.reduce((sum, entry) => sum + entry.regions.filter(region => region.lockIds.length > 0).length, 0),
            waitingCount: waitingIds.size,
            contendedRegions: resultFiles.reduce((sum, entry) => sum + entry.regions.filter(region => region.status === 'contended').length, 0),
        },
    };
}
