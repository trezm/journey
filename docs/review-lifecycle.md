# Review after accepted work

Submitting a Journey for review officially posts it. Its valid locks become durable reservations until that Journey is integrated or abandoned. Publishing a patch alone does not post a Journey: draft locks still expire 10 minutes after their last renewal. Submission requires the current revision, at least one published patch, an explicit compatibility declaration, reconciliation with current main, resolved change requests, and valid locks covering the changes.

Publishing edits and integrating a Journey require current lock tokens and coverage for every caller, including the repository owner. Posted locks need no keepalive and survive review requests, later patches and reconciliation. Active reservations held by other Journeys continue to protect overlapping changes, including file creation and deletion. See [Lock lifecycle](lock-lifecycle.md) for expiry and recovery details.

When every intervening integration is marked **unaffected**, reconciliation retains a valid compatibility declaration. A Journey already submitted for review stays in review; a Journey still in progress stays in progress. Reconciliation invalidates earlier approvals, so the new exact revision must be approved before integration when approval is required. Outstanding change requests remain unresolved and continue to block approval and integration.

If any integration is marked **adapted**, the Journey returns to in progress and needs a fresh compatibility declaration and submission. **Needs review**, incomplete dispositions, stale integration details, and merge conflicts fail without changing the Journey.

Reconciliation against an already-current main and integration cursor returns the existing revision without creating a commit or event or invalidating its approval.

The reconciliation response includes the current `status` and `manifestDeclared` fields. Existing clients can continue reading its `revision`. The additive `posted` Journey marker and `retained` lock flag record durable reservations; no database schema change is required.

## Recover Journeys reset by the earlier behavior

Earlier reconciliation returned submitted Journeys to in progress and cleared `manifestDeclared`, while retaining the declaration's content. After this fix is deployed, verify that the existing declaration still describes the reconciled work, save it again (or explicitly declare no breaking changes), and submit the current reconciled revision. The declaration and reconciliation steps do not release posted locks. If this Journey lost its locks before durable reservations were introduced, acquire fresh scopes before submitting or integrating; expired tokens are never restored.

Recovery does not restore earlier approvals. When approval is required, a reviewer must approve the current exact revision before integration.
