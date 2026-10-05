import { GitHubTransport, githubTarget } from './github-transport.ts';
import { GitLabTransport, gitlabTarget } from './gitlab-transport.ts';
export function remoteProvider(remote: string): 'github' | 'gitlab' {
    if (remote.startsWith('https://gitlab.com/')) { gitlabTarget(remote); return 'gitlab'; }
    githubTarget(remote); return 'github';
}
export function providerTransport(remote: string, token: string, send: typeof fetch = fetch, execution?: AbortSignal, carrier?: string, beforePush?: () => Promise<void>) {
    return remoteProvider(remote) === 'gitlab' ? new GitLabTransport(gitlabTarget(remote), token, send, execution, carrier, beforePush) : new GitHubTransport(githubTarget(remote), token, send, execution);
}
