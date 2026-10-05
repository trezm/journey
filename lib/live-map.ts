import type { LiveChangeset, LiveFile } from './avc/live.ts';

/** Stable priority: blocked held locks, all held locks, latest activity, then path. */
export function compareLiveFiles(a: LiveFile, b: LiveFile) {
    return b.conflictCount - a.conflictCount || b.lockCount - a.lockCount || b.updatedAt - a.updatedAt || a.path.localeCompare(b.path);
}

export type LockGraphEdge = { file: string; changeset: string; lockCount: number; conflictCount: number };

/** Only actual ownership draws an edge; historic patches and queued requests do not. */
export function lockGraph(files: LiveFile[], changesets: LiveChangeset[]) {
    const open = new Map(changesets.filter(change => change.status === 'working' || change.status === 'review').map(change => [change.id, change]));
    const edges: LockGraphEdge[] = [];
    const connected = new Set<string>();
    const lockedFiles = files.filter(file => {
        const owners = new Map<string, LockGraphEdge>();
        for (const lock of file.heldLocks) {
            if (open.get(lock.changeset)?.journey !== lock.journey) continue;
            let edge = owners.get(lock.changeset);
            if (!edge) { edge = { file: file.path, changeset: lock.changeset, lockCount: 0, conflictCount: 0 }; owners.set(lock.changeset, edge); }
            edge.lockCount++; edge.conflictCount += Number(lock.conflictingRequestIds.length > 0);
            connected.add(lock.changeset);
        }
        edges.push(...owners.values());
        return owners.size > 0;
    });
    return {
        files: lockedFiles,
        changesets: [...open.values()].filter(change => connected.has(change.id)).sort((a, b) => b.lockCount - a.lockCount || a.title.localeCompare(b.title) || a.description.localeCompare(b.description) || a.id.localeCompare(b.id)),
        edges,
    };
}
