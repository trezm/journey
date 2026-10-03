# Journey — Agentic Version Control

Working MVP of journey-based version control. A journey contains described changesets; changesets contain immutable patches and version-anchored range leases. Intermediate revisions stay isolated. The completed journey integrates as a Git commit on `main`.

## Implemented

- Human repository workspace, code editor, patch timeline, exact-revision review and approvals.
- Repository-scoped agent credentials and HTTP API. Agents own their journeys and may comment on other reviews; approvals require a human.
- Inclusive line ranges tied to Git revisions; conservative internal range remapping; whole-file fallback; atomic multi-scope acquisition.
- Ten-minute draft leases, explicit refresh, generation fencing, durable waiting requests, availability hints and explicit retry. Submit for review retains valid locks indefinitely until integration or abandonment, including through further updates and reconciliation.
- Immutable Git blobs, trees and commits stored in R2; authenticated dumb-HTTP Git cloning. Agents publish through the coordinated API, rather than raw Git push.
- Append-only review, patch, lease and integration events; per-journey inboxes with replay cursors.
- Required breaking-change declarations (explicit empty lists allowed), per-integration dispositions, stale-head rejection and repository-state compare-and-swap publication.
- Optional approval policy. Builds and tests are deliberately outside the protocol.
- Email/password accounts and hashed sessions for Cloudflare hosting. Public identity headers are never accepted as authentication.

## Import and connect Codex

1. Create an empty repository in the workspace (the Rust example is optional).
2. In **Connect & import**, download `journey.mjs` and `journey-connection.json`.
3. With Node.js 22+ and Git installed:

```sh
node journey.mjs connect journey-connection.json
node journey.mjs import /path/to/existing/repository
```

The importer verifies and uploads loose Git objects in retryable batches. It retains all committed **local** branches and tags and their reachable histories, including binaries, executable bits, symlinks and submodule pointers. The selected local HEAD becomes canonical Journey main. A differing source main is retained under imported/main (with a numeric suffix if that name exists). Remote-tracking refs, uncommitted working edits, Git LFS payloads and submodule repository contents are not uploaded. Unshallow shallow clones first. Initial import limits: 50,000 SHA-1 objects, 1,000 refs, 20 MB per object and 300 MB uncompressed total.

Open Codex in the imported local directory and use `.journey/CODEX_PROMPT.md`, replacing the task placeholders. Ask the coordinator to spawn parallel agents. `start "Task title" /new/directory` creates a separate journey, worker credential and authenticated isolated clone for each task. Node and Git are the only CLI dependencies. Journey does not itself launch Codex processes; the Codex session must provide spawning tools.

The local `.journey/AGENTS.md` contains the full protocol contract. The existing root `AGENTS.md` stays intact. A background watcher refreshes draft leases every minute and writes durable inbox events to `.journey/inbox.jsonl`. Posted locks need no renewal and stay reserved until integration or abandonment. Draft leases that expire before posting require fresh acquisition; expired tokens are never revived. Connection profiles have mode 600 and are stored under `~/.config/journey`; local `.journey/` is excluded through Git's local `info/exclude`. The downloaded connection contains credentials, including the private-host access credential when configured; do not share it or add it to Git. Tokens can be revoked with the owner API.

Imported untouched non-text/large files and modes remain in every generated commit. The initial patch API edits UTF-8 regular files up to 500 KB, with an editable snapshot of at most 4,000 files/12 MB. Binary, symlink, submodule and permission edits are explicitly rejected by the CLI. Large-file diffs use a conservative bounded hunk and may need a wider lock. Git cloning currently uses dumb HTTP and can be slow for large histories.

`POST /api/connect` is owner-only and downloads a new coordinator connection. `POST /api/import?project=ID&op=start|objects|finish|cancel` is owner/coordinator-only; finish verifies reference closure before publishing the imported head. Import is allowed only before any journeys begin and once per destination repository. A worker cannot import, delegate, change policy or approve a journey.

## Development

Node.js 22.13+ and Git are required. Install with `pnpm install --frozen-lockfile`, initialize local D1 with `pnpm db:migrate:local`, and run `pnpm dev`. `pnpm deploy:check` builds the complete Cloudflare Worker and validates its bundle without publishing. `pnpm start --port 4173` serves the built Worker locally; both use simulated D1/R2 under `.wrangler/state`.

Deploy to your own Cloudflare account using the checked-in `wrangler.jsonc`, with `DB` (D1), `BUCKET` (R2) and the existing Drizzle migrations. Configure the actual resource IDs/names before `pnpm db:migrate:remote` and `pnpm deploy`; these commands reject the local placeholder D1 ID. The app uses email/password sessions and repository-scoped agent tokens and needs no Sites runtime, connectors or platform service secret.

Follow [the Cloudflare deployment and migration guide](docs/cloudflare.md) for resource setup, domains, CI, moving existing D1/R2 data, mapping former ChatGPT owners and reconnecting local agents. Existing hosted repositories are not copied automatically when a new Worker is deployed.

## API

All agent requests send `Authorization: Bearer <agent-token>`. Standalone Cloudflare hosting uses the application token directly. Old CLI profiles retain optional private-Site support for migration; newly downloaded connections do not include platform credentials.

- `GET /api/avc`: signed-in human's repository list.
- `GET /api/avc?project=ID`: state and revisions. Agents see only their own lock tokens.
- `GET /api/avc?project=ID&revision=SHA`: immutable file snapshot.
- `GET /api/avc?project=ID&journey=J&since=N`: relevant events and resumable cursor. Agent inboxes are owner-scoped.
- `POST /api/avc`: JSON command. Bootstrap repository/token creation uses authenticated human requests. Every journey protocol mutation requires `project`, unique `requestId`, `action`, and (where applicable) `journey`. Retry the identical body with the same request ID. Reusing it with different content is rejected.

| Action | Additional fields |
| --- | --- |
| create_project | name, empty: true for import, optional files mapping paths to text (human only) |
| create_agent | name, optional coordinator: true (human only; token returned once) |
| delegate_agent | name (coordinator only; worker token returned once) |
| revoke_agent | token (human only) |
| create_journey | title, description |
| create_changeset | description |
| acquire | changeset, revision, scopes: [{path,start,end,whole?}] |
| record | kind: command/explanation/decision, provenance: captured/reconstructed, description, optional changeset; commands also supply command, output, exitCode |
| refresh | tokens: [current lease tokens] |
| patch | changeset, revision, description, edits: [{path,content}], tokens |
| declare_breaking | changes: [{target,kind,before,after,migration}] or [] |
| submit | revision, tokens |
| review | revision, kind: comment/request_changes/approve, body, optional changeset/patch anchor |
| resolve_review | review: request ID |
| reconcile | head, cursor: current integrationCursor, dispositions: {eventId: unaffected/adapted} |
| integrate | revision, head, cursor, tokens |
| abandon | no additional fields |
| policy | requireApproval: boolean (human only) |

Patch edits contain full replacement text; `null` deletes a file. Creating or deleting files requires a whole-file lease. The server computes multi-hunk diffs and checks them against changeset ownership. Range insertions at shared boundaries are conservatively conflicting. Submission and integration validate complete lock coverage; owners and workers must return all current lock tokens when integrating. See [Lock lifecycle](docs/lock-lifecycle.md) for posting and existing-Journey recovery.

`lock.available` is a retry hint, not a grant. A successful `acquire` response returns new fenced tokens. Refresh draft leases with a new request ID every minute. Successful submission validates complete coverage and marks the Journey posted; its existing and future locks are retained until integration or abandonment. The API exposes `journey.posted` and `lease.retained`, with retained status authoritative over the numeric compatibility deadline. Expiry applies only to unposted leases and is processed on protocol reads and mutations; an agent polling its inbox receives expiry and availability events after a draft lease deadline. Inbox and state reads process expiry and notify waiting journeys; polling does not refresh leases.

Reconciliation merges disjoint changes from the accepted head into the isolated journey. Overlapping changes fail conservatively. Reconciliation or new patches invalidate the breaking-change declaration and previous approval. An `adapted` disposition is an agent declaration; it is not a proof of compatibility.

## Agent CLI

Set `AVC_URL`, `AVC_PROJECT`, `AVC_TOKEN`, and, for a private hosted preview, `AVC_SITE_SERVICE_TOKEN`. Keep credentials outside tracked files.

```sh
node cli/agent.mjs state
node cli/agent.mjs request command.json
node cli/agent.mjs poll JOURNEY_ID 0
node cli/agent.mjs keepalive JOURNEY_ID
node cli/agent.mjs patch JOURNEY_ID CHANGESET_ID src/users.rs ./users.rs 'Handle missing users'
```

## Git and Cloudflare Artifacts

The app stores actual Git objects, not synthetic revision labels. `GET /api/git/PROJECT_ID/` supports Git dumb-HTTP cloning with an agent token as the Basic-auth password or a bearer header. It exposes main and journey refs; writes must use the journey API.

Cloudflare hosting uses R2 Git-object storage. **Cloudflare Artifacts is not connected automatically.** Create an Artifacts repository, obtain its remote and write token, then set `ARTIFACTS_REMOTE` and `ARTIFACTS_TOKEN` alongside the AVC environment variables:

```sh
node cli/sync-artifacts.mjs
```

The bridge clones this repository and pushes only accepted `main` history to Artifacts using ordinary Git. It preserves Git commits and excludes isolated journey branches from publication. It does not import arbitrary existing Artifacts repositories or make Artifacts the authoritative store; that next stage needs an Artifacts binding and a recoverable remote-publication/outbox state machine.

## Validation

```sh
node --experimental-strip-types --test tests/protocol.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Tests cover non-overlapping merge, range remapping, lease expiry/fencing, waiting notification, atomic acquisition, deadlock prevention, patch coverage, declaration/reconciliation gates and lock return. Git interoperability is verified with the real `git fsck` and `git show` commands. `tests/http-smoke.mjs` exercises the running D1/R2 API with two authenticated agents. `tests/cli-smoke.mjs` exercises the downloadable CLI from connection/import through two isolated worker edits, human review, integration and reconciliation, verifying original branches, tags, binaries, modes and Git history with real Git.

## MVP boundaries

Import limits and text-edit limits are described above. Journey metadata remains bounded at 1 MB/request, 100 changesets/journey, 1,800 durable events/repository and 1.5 MB/stored repository metadata (up to 12 MB before lossless compression). Limits fail explicitly. Untouched binary, symlink, executable and submodule entries are preserved, but editing binaries or modes, rename identity tracking, arbitrary server-side CI execution, secret scanning, email delivery/password recovery, organization membership and webhooks remain unimplemented. Git LFS payloads and submodule contents stay external. Recordings capture explicit patches, explanations, decisions and CLI command results, not private model reasoning. Captured and reconstructed entries are labeled separately. The coordinator uses transactional D1 compare-and-swap over repository state; a dedicated Durable Object is the intended high-contention successor.

MIT licensed.
