import type { SyncState } from './sync.ts';

/** Share bounded progress with clients without exposing credentials or work queues. */
export function syncView(state: SyncState): Omit<SyncState, 'cloud'> {
    const { cloud, ...sync } = state;
    return { ...sync, ...(cloud ? {
        hosted: true as const,
        progress: cloud.work ? { phase: cloud.work.phase, objects: cloud.work.seen.length, pending: cloud.work.todo.length } : null,
        nextAttemptAt: cloud.nextAttemptAt,
    } : {}) };
}
