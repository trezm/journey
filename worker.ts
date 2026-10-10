// Vinext handles server rendering and API routes in the same Workers runtime.
import handler from 'vinext/server/fetch-handler';
import { runCloudSync, scheduledGitHubSync } from './lib/avc/github-cloud';
import { readProject } from './lib/avc/storage';
const worker = {
    fetch: handler.fetch,
    async scheduled(_event: ScheduledController, env: Env) {
        if (env.GITHUB_SYNC_KEY) await scheduledGitHubSync(env.GITHUB_SYNC_QUEUE);
    },
    async queue(batch: MessageBatch<{ project: string }>, env: Env) {
        for (const message of batch.messages) {
            if (env.GITHUB_SYNC_KEY && typeof message.body.project === 'string') {
                await runCloudSync(message.body.project, env.GITHUB_SYNC_KEY);
                const sync = (await readProject(message.body.project)).state.sync;
                if (sync?.enabled && sync.status === 'running' && sync.cloud?.work && !sync.cloud.lease) await env.GITHUB_SYNC_QUEUE.send({ project: message.body.project }, { delaySeconds: 0 });
            }
            message.ack();
        }
    },
};
export default worker;
