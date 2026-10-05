# Personal repository visibility

Each repository belongs to one personal account. There are no organizations,
collaborators, or account-to-account write permissions. New repositories and all
repositories migrated from older releases are private by default.

The owner can choose **Private** or **Public** when creating a repository, or
change it in repository settings. Private repositories are readable and writable
only by the owner and agents with credentials scoped to that repository. Existing
agent role, journey ownership, approval, and integration rules still apply.

Public repositories appear in the repository picker for signed-in accounts and on
the public discovery screen for anonymous visitors. Anyone may read accepted code
and history. Other accounts cannot create journeys, edit code, issue credentials,
review changes, import history, or manage sync or repository settings.

The public API projects only accepted repository revisions. It excludes all
journeys (including published drafts and their recordings), locks, waiting scopes,
inboxes, reviews, approval queues, receipts, sync settings, backup refs, and import
sessions. Account email addresses and internal revision actor identities are not
included in the public projection; the owner's public username identifies them.

The public Git endpoint advertises only `refs/heads/main`. Objects must be reachable
from that accepted head, including its commit ancestry and file trees. Knowing an
unpublished commit/blob hash or an imported side branch hash does not grant read
access. Public Git history preserves original Git commits, including original
author metadata. A repository owner should account for that metadata and for
secrets already committed to accepted history before making the repository public.
The public object index is stored per accepted head and is never itself served.
History is bounded to 50,000 reachable Git objects (10,000 commits for revision
lookups); larger public requests fail closed.

Visibility changes apply to subsequent requests. API responses and Git objects
use `Cache-Control: private, no-store`; downloaded copies cannot be recalled when
a repository is made private. An explicitly supplied invalid repository credential
always fails rather than falling back to anonymous public access. Tokens scoped
to another repository also cannot use public access as a fallback.

## API additions

- `GET /api/avc` returns owned repositories plus public repositories. `user` is
  nullable for anonymous visitors. Repository summaries include `visibility`,
  `owner: { username }`, and `permissions: { read: true, write: boolean }`.
- `GET /api/avc?project=ID` returns `project` with that summary alongside `state`
  and `user`. Nonowners receive the public state projection.
- `GET /api/avc?project=ID&revision=SHA` permits accepted commit ancestors for
  public readers. Journey inboxes and approval queues remain owner/agent only.
- `POST /api/avc` with `action: "create_project"` accepts an optional `visibility`;
  omitting it creates a private repository.
- `POST /api/avc` with `action: "visibility"`, `project`, and `visibility` changes
  visibility for the owner. Repository agents cannot change visibility.

Apply D1 migrations before deploying this version, including
`0004_repository_visibility.sql`. Existing records receive `private` without
rewriting repository Git objects or Journey state.
