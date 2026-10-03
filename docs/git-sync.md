# Git publishing and synchronization

Journey can synchronize accepted `main` history with one branch on a generic Git remote. The remote may be GitHub, GitLab, Cloudflare Artifacts, or another HTTPS/SSH Git server. Deployment services watch that remote using their own configuration. Journey does not need their APIs, build credentials, or deployment settings.

## Connect a repository

1. Open the repository's **Settings** and configure the credential-free remote URL, target branch, and enabled switch. Use a repository with shared history, an empty remote, or import the existing project into Journey first. Configuration and conflict resolution require the human owner.
2. Download `git-sync.mjs` and a coordinator connection from the settings page. Keep the connection file private; it contains a repository credential.
3. On a trusted machine with Node.js 22.13+ and Git, configure access to the Git remote. Keep Git credentials on this machine. Do not put a password or token in the remote URL saved in Journey.
4. Start the runner:

   ```sh
   node git-sync.mjs --connection journey-connection.json --watch
   ```

   For a single synchronization attempt, use `--once` instead. From this source checkout, the equivalent entry point is `node cli/sync-git.mjs`.

Keep the runner alive under your usual process supervisor for continuous publishing and incoming sync. It uses a temporary, isolated Git checkout, not your working repository. The application stores durable sync state in its existing repository metadata and Git objects in R2. No database migration or additional Cloudflare binding is required. The request Worker itself does not execute native Git.

For HTTPS remotes, the runner uses your Git credential helper. A supervised runner can instead receive `GIT_SYNC_REMOTE_TOKEN`, `GIT_SYNC_REMOTE_URL`, and, if needed, `GIT_SYNC_REMOTE_USERNAME` through its environment. The URL must exactly match the configured Git remote before the token is sent; changing the remote does not silently forward the same credential elsewhere. SSH remotes use the machine's SSH authentication.

Restart a failed runner with the **same coordinator connection** so it can recover the existing operation. A new connection is a different coordinator and cannot take over another coordinator's active run. Authentication or connectivity failures remain visible; they do not silently release a possibly partially published operation.

For an Access-protected Journey host, the runner needs access to the exact `/api/sync` endpoint and the existing authenticated `/api/git/*` endpoint. Configure a narrowly scoped Access bypass for `/api/sync` if using the application's coordinator authentication. The endpoint still enforces its own repository and role checks. The settings UI and `/api/connect` remain protected by Access. See [Cloudflare hosting](cloudflare.md).

## Synchronization policy

The runner fetches the configured remote branch and compares it with Journey's current `main`. Equal heads require no publication and update the last-checked status at most once per minute. If Journey is ahead, it publishes accepted commits. If the remote is ahead, Journey adopts those exact commits. When both have new commits, native Git rebases Journey's unpublished commits onto the captured remote head. Unrelated histories pause for manual resolution.

Before rebasing, the server invalidates leases that overlap incoming changes. A sync operation holds a repository write barrier so the selected head cannot change underneath it. After a successful sync, workers read the notification, reconcile their isolated journeys, and reacquire invalidated scopes on the new revision. External Git updates are explicitly recorded as external updates; they do not imply Journey review or an empty breaking-change declaration. See [Lock lifecycle](lock-lifecycle.md).

The runner stages its candidate in Journey before publishing. Pushes specify the exact expected remote branch SHA using `--force-with-lease`. A moved remote head requires another fetch and assessment. If a push succeeds but its acknowledgment is lost, the runner can recognize the already-published candidate and finish the same operation. Network errors retain the operation and its original heads for recovery.

Rebasing changes commit IDs. Journey keeps the original objects, recorded patches, reviews and events, records replacement mappings, and advertises backup Git refs under `refs/heads/journey-sync/`. Historical approvals are not rewritten to approve replacement commits. The synchronized canonical head is recorded separately.

## Resolve a conflict

A Git rebase conflict pauses writes and automatic synchronization for the affected repository. Reading, cloning, history inspection and recovery remain available. Other repositories continue independently.

The runner publishes the **original Journey head**, before any rebase steps, to a unique branch named `journey-conflicts/<sync-id>`. The warning shows the preserved Journey SHA, captured remote SHA, conflict branch and conflicting paths. Branch publication is reported separately: if permissions or connectivity prevent publishing it, the repository stays paused and the runner retries publication. The warning does not claim the branch exists until publication succeeds.

1. Fetch the remote's target branch and the conflict branch in your own Git checkout.
2. Resolve the combined changes using Git. You can merge or rebase the conflict branch onto the latest target branch, resolve each conflict, and run the project's checks.
3. Push the resolved history to the configured remote branch.
4. In Journey's warning, enter the full resolved commit SHA and select **Resume sync**. Keep the original runner running.

The runner verifies that the remote branch points to the selected SHA, uploads its objects, and adopts that exact resolution. It does not replay the saved pre-conflict commits. If the remote has moved again, recovery remains paused until the selected resolution is updated deliberately. The conflict branch and local backup refs remain available as history; sync does not delete them automatically.

## Boundaries

This version tracks one remote branch per repository. Isolated journey branches are not automatically published; the exceptional conflict branch preserves accepted Journey `main`. Git LFS payloads and submodule repository contents remain external. Git object and repository metadata limits still apply, and inbound synchronization validates complete object history before publishing a head.

Sync can bring in binary files, symlinks, submodule pointers and permission changes. Journey's existing editor still supports only its bounded UTF-8 regular-file subset. An active journey with edits overlapping an external change may need deliberate conflict resolution or a fresh journey based on the synchronized head; its old patches remain preserved.
