import type { SyncState } from './sync.ts';

/** Share bounded progress with clients without exposing credentials or work queues. */
export function syncView(state: SyncState): Omit<SyncState, 'cloud'> {
    const { cloud, ...sync } = state;
    const work = cloud?.work, ancestry = work?.ancestry;
    return { ...sync, ...(cloud ? {
        hosted: true as const,
        progress: work ? { phase: work.phase, objects: ancestry ? ancestry.incomingSeen.length + ancestry.outgoingSeen.length : work.seen.length, pending: ancestry ? ancestry.incoming.length + ancestry.outgoing.length : work.todo.length } : null,
        nextAttemptAt: cloud.nextAttemptAt,
    } : {}) };
}
