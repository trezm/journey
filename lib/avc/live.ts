import { diff, leaseActive, lines, projectRange, touches, type Files, type Hunk, type Journey, type State, type Waiting } from './core.ts';

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
export type LiveFile = { path: string; lineCount: number; exists: boolean; regions: LiveRegion[] };
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
            value = { path, lineCount: Math.max(1, lines(content(canonical, path)).length), exists: Object.hasOwn(canonical, path), regions: [] };
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
    for (const lease of state.leases) {
        if (!activeJourneys.has(lease.journey) || !leaseActive(lease, now) || !changesets.has(lease.changeset)) continue;
        add(lease.path, lease.whole ? 0 : lease.canonicalStart, lease.whole ? file(lease.path).lineCount : lease.canonicalEnd,
            { lock: lease.id, changeset: lease.changeset, approximate: !lease.whole && !Object.hasOwn(canonical, lease.path) });
    }
    // Grouping caches each source revision's load and each file diff for this request,
    // while keeping at most canonical + one source snapshot in memory. Reads are serial.
    const byRevision = new Map<string, Waiting[]>(), waitingIds = new Set<string>();
    for (const waiting of state.waiting) {
        if (!activeJourneys.has(waiting.journey) || !changesets.has(waiting.changeset) || waitingIds.has(waiting.id)) continue;
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
            add(scope.path, start, end, { waiting: waiting.id, changeset: waiting.changeset, approximate });
        }
    }
    for (const [path, values] of overlays) file(path).regions = regions(values);
    for (const changeset of changesets.values()) {
        changeset.paths = [...pathSets.get(changeset.id)!].sort();
        changeset.lockCount = lockSets.get(changeset.id)!.size;
        changeset.waitingCount = waitingSets.get(changeset.id)!.size;
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
