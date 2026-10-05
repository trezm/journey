# GitHub and GitLab connections

Sign in to Journey with your username or email and password. In an owned repository, open **Settings → Git publishing & sync**, connect a GitHub or GitLab account, choose a repository, select its branch, enable sync, and save. OAuth connects a Git provider to your existing Journey account; it does not create a second Journey login or an organization.

This version accepts writable personal GitHub and GitLab repositories only. Provider organization/group repositories and Journey organizations are not supported yet.

Connections belong to the signed-in account. Repository owners alone can inspect provider accounts, list repositories, configure sync, or reconnect credentials. Public Journey readers and repository agents cannot inspect provider connections or authorize them. Public/private visibility in Journey remains separate from the provider repository's visibility.

## Deployment setup

Apply migrations through `0005_oauth_connections.sql` before enabling OAuth. Existing token-based GitHub sync continues to work. The existing `GITHUB_SYNC_QUEUE` and `GITHUB_SYNC_KEY` now service both providers; their names remain unchanged for deployment compatibility.

Set these non-secret variables in `wrangler.jsonc` for the deployed environment:

- `AVC_OAUTH_ORIGIN`: the canonical origin, for example `https://journey.example.com`, with no path, query, or fragment. HTTPS is required except localhost development.
- `AVC_GITHUB_CLIENT_ID`: the GitHub OAuth application's client ID.
- `AVC_GITLAB_CLIENT_ID`: the GitLab OAuth application's application ID.

Supply `AVC_GITHUB_CLIENT_SECRET` and/or `AVC_GITLAB_CLIENT_SECRET` as Worker secrets with `pnpm cf secret put SECRET_NAME`. Keep the existing `GITHUB_SYNC_KEY` secret, a 32-byte lowercase hexadecimal AES key. Changing or losing that key makes stored connections unreadable and requires reconnecting affected accounts. Do not place client secrets or provider tokens in source, browser configuration, logs, or CLI connection files. In local development, use ignored `.dev.vars` settings. A provider without its complete configuration is disabled independently; enabling GitHub does not require GitLab credentials.

Register provider applications with these exact callback URLs, substituting the canonical origin:

- GitHub OAuth App: `https://journey.example.com/api/oauth/github/callback`.
- GitLab confidential OAuth application: `https://journey.example.com/api/oauth/gitlab/callback`.

GitHub requests `repo workflow` so private repository history and workflow-file changes can be synchronized. GitLab requests `read_user read_api write_repository` for identity, repository metadata, object reads, and Git HTTPS writes. Only github.com and gitlab.com are supported. Enterprise/self-hosted provider hosts need a separate validated configuration and are not accepted as arbitrary remote origins.

Journey sessions use SameSite=Lax so the browser sends the existing session on a top-level OAuth callback. Start requests require same-origin POST with an Origin header. Callback state expires after ten minutes, is bound to the initiating account and session, and is consumed atomically before exchanging the code. Both providers use PKCE S256 and a fixed callback URL. Switching accounts, logging out, replaying state, or changing sessions invalidates the attempt. Cloudflare Access deployments bind to the verified Access assertion instead of the application session; an assertion refresh during the flow may require restarting it.

Provider tokens and PKCE verifiers are AES-GCM encrypted with account/context binding. Provider tokens never reach the browser or Journey worker credentials. Expiring access tokens are refreshed server-side; D1 leases serialize rotating refresh tokens across concurrent repository jobs. Reconnect the account if the provider revokes access or the refresh token expires. To revoke a connection, disable its repository sync configurations and revoke Journey in the provider's authorized-applications page; the UI currently supports connection and reconnection, not account unlinking.

## Hosted transfer behavior

Both providers run through the existing bounded Cloudflare queue workflow. GitHub uses its Git database APIs and Git smart HTTP. GitLab uses filtered smart HTTP for exact raw commits/trees and its API for blobs. To upload each object without a repository-sized pack, GitLab advances one `journey-objects/<project>/<generation>` scratch branch with small carrier commits. Keep this branch while sync is enabled; it makes partially transferred objects reachable across queued continuations and provider garbage collection. After disabling sync and verifying that the target/conflict branches preserve the wanted history, an owner may remove obsolete scratch branches. Branch protection or provider permissions can still reject writes; Journey preserves both heads and surfaces recovery.

Target and preservation branches use Git receive-pack with the exact previous object ID. A concurrent remote edit is never overwritten blindly. Signed commit bytes, binary files, executable modes, symlinks and Git object hashes are preserved. The existing limits of 8 MB per object and 50,000 objects per transfer apply. Divergent histories pause for the owner to merge preserved history and choose the resolved remote head.

Provider setup references: [GitHub OAuth authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [GitLab OAuth authorization and token refresh](https://docs.gitlab.com/api/oauth2/), [GitLab OAuth application scopes](https://docs.gitlab.com/integration/oauth_provider/), and [GitLab partial clone support](https://docs.gitlab.com/topics/git/clone/).
