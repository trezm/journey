import type { State } from './core.ts';

/** Called in the same transaction that advances main. Successful polling's
 * cooldown must not delay fresh work; provider failure backoff still applies. */
export function wakeIntegratedSync(state: State) {
    const sync = state.sync, cloud = sync?.cloud;
    if (!sync?.enabled || !cloud || sync.status !== 'idle' || sync.run || cloud.work || cloud.failures) return false;
    delete cloud.nextAttemptAt;
    return true;
}
export async function enqueueIntegratedSync(project: string, queue: Queue<{ project: string }> | undefined) {
    try { await queue?.send({ project }, { delaySeconds: 0 }); }
    catch { console.error('cloud_sync_enqueue_failed', { project }); }
    // Integration is already committed. The scheduler remains a durable fallback
    // if the queue is unavailable; do not turn success into an ambiguous error.
}
