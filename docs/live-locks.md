# Live file and changeset map

The authenticated `GET /api/avc?project=ID&live=1` endpoint returns a coherent metadata snapshot of one repository state and its immutable canonical Git revision. `head` identifies that revision, `sequence` identifies the event cursor, and `updatedAt` is the snapshot time. Responses are private and not cached. The response contains no lock tokens, credentials, source contents, patch hunks, or event payloads.

`files` contains the editable text files on main plus paths referenced by locks, waiting requests, and historical patches. Each file reports `path`, `lineCount`, `exists`, and disjoint `regions`. Empty or missing files use one virtual row. Binary files and other entries outside Journey's editable text snapshot are not visualized.

Regions use one-based inclusive line numbers on main. Each includes `lockIds`, `waitingIds`, `changesetIds`, and a status:

- `locked`: blue, a held region with no queued requests.
- `waiting`: yellow, one distinct pending acquisition request.
- `contended`: red, two or more distinct pending acquisition requests.

Counts describe acquisition requests, not calls or workers: repeated retries of the same journey and changeset retain one waiting identity. A changed retry replaces that request's source revision and requested scopes. Overlapping scopes within one request count once per region. A batch can cover multiple files and contributes once to the repository and changeset waiting counts. Waiting entries persist until acquisition succeeds or the journey closes; they are an estimate of requested work and do not prove that the requester is still online. `lock.available` only invites a retry and does not remove the request or grant a lease.

Held ranges use canonical lease coordinates. Waiting ranges project their original revision onto the same main revision. If changed lines make that projection ambiguous, `approximate` is true. A held or waiting range that collapses or must be clamped to visible lines is also approximate; deleted ranges collapse to the nearest line. Whole-file requests cover the current entire file, including an absent file's intentional virtual row. Conservative lock exclusion includes adjacent boundaries, so a waiting region may be adjacent to its blocking lock without sharing a displayed line. The map does not manufacture overlaps for those boundaries.

`changesets` provides journey identity/title/status, changeset description, related `paths`, and counts of unique locks, requests, and patches. Patch history relates a changeset to file paths only; historical patch lines are never painted as current locks. Released, expired, integrated, and abandoned locks are not colored. Retained posted locks remain active regardless of their numeric deadline.

`summary.fileCount` includes all returned file cards. `summary.lockedRegions` counts disjoint displayed regions with a held lock, including yellow/red regions. `summary.waitingCount` counts distinct queued requests across files. `summary.contendedRegions` counts red regions. Region boundaries can split as activity changes; they are not a count of granted lease identities.

The endpoint reads each waiting source revision at most once per request, with serial Git reads and per-path diff reuse. It holds the main snapshot plus at most one historical snapshot in memory. All coordinates and links derive from the single captured repository state, so a later integration appears on the next refresh.
