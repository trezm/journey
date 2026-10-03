# Repository settings and coordinator review

Open a repository workspace and choose **Settings**. Only its signed-in owner can save permissions. Changes apply to every journey in that repository.

- **Allow workers to merge** starts on, preserving existing repositories. Workers can integrate only their own journeys. They must still return valid leases, reconcile the latest main and integration cursor, and have approval of the exact current revision when approval is required. Turn it off to have the owner merge completed journeys.
- **Allow the coordinator to approve** starts off. Turn it on to allow coordinator-role repository credentials to review and approve other workers' submitted journeys. Worker credentials cannot approve. Coordinators cannot approve their own work, another coordinator's work, or human-authored journeys.
- **Require approval before merge** retains the existing policy. When on, an owner or an allowed coordinator must approve the exact revision. Patches, reconciliation and compatibility declarations require another review.

Turning coordinator approval off permanently cancels its existing approvals. Turning it back on does not revive them; the affected journeys need a new approval when approval is required. Human approvals retain their existing behavior. New journeys and approvals record the authenticated author role and review authority; caller-supplied authority fields cannot grant permission. Legacy worker journeys are eligible when their repository credential still identifies the actor as a worker. Unknown or revoked legacy actors remain available for human review.

## Coordinator commands

Download the current `journey.mjs` and use it to set up your coordinator checkout. It works without a current journey:

```sh
node .journey/journey.mjs approvals
node .journey/journey.mjs inbox
node .journey/journey.mjs watch --background
```

The approval feed includes exact submitted revisions and explains blocked candidates, including stale reconciliation, unresolved changes requests and disabled coordinator permission. `ready` lists only current, reviewable, unapproved candidates that this credential may approve. A coordinator's own journeys and other coordinator or human work are excluded. This feed returns no leases or credentials.

The coordinator watcher writes `.journey/coordinator-inbox.jsonl` and uses a separate `.journey/coordinator-cursor`. It records readiness changes after integrations, patches, review requests, declarations and settings changes. Watching never approves a journey automatically.

After reviewing the full journey, its checks and declared compatibility changes, approve the exact revision reported by the current queue:

```sh
node .journey/journey.mjs approve JOURNEY_ID EXACT_REVISION "Reviewed the complete feature"
```

The CLI checks readiness and the exact revision. The server enforces authority and current policy again, so a permission or revision change between reading and approving rejects the request. Approval does not merge a journey. The worker still uses `integrate`, subject to repository settings and the normal protocol.

For environment-based tooling, `cli/agent.mjs` provides `approvals [cursor]`, `approve <journey> <exact-revision> [description]`, and `poll-approvals [cursor]` using a repository credential.

## API compatibility

The human-only `policy` action accepts any nonempty subset of boolean `requireApproval`, `allowWorkerMerge` and `allowCoordinatorApproval` fields. Existing `{requireApproval: true}` requests remain supported. Omitted new fields read as `allowWorkerMerge: true` and `allowCoordinatorApproval: false`.

`GET /api/avc?project=ID&approvals=1&since=CURSOR` is available to the owner and coordinator credentials. It returns current policy, `canApprove`, canonical `head`, `integrationCursor`, event `cursor`, all submitted `queue` candidates with reasons, a filtered `ready` list and relevant repository events since the cursor. Workers receive HTTP 403. The standard journey inbox and cursor retain their behavior.

Approvals use the existing `review` action with `kind: "approve"`, a journey ID and its exact current `revision`. The server stores `authority: "human"` or `"coordinator"` from the authenticated principal, never from the request body. Lease validation, locking, request idempotency and reconciliation remain required for publication and integration.
