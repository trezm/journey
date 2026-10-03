# Review after accepted work

A published Journey can be submitted for review without active editing locks. Submission still requires its current revision, at least one published patch, an explicit compatibility declaration, reconciliation with current main, and resolved change requests. Publishing edits and integrating a Journey retain their existing lock checks.

When every intervening integration is marked **unaffected**, reconciliation retains a valid compatibility declaration. A Journey already submitted for review stays in review; a Journey still in progress stays in progress. Reconciliation invalidates earlier approvals, so the new exact revision must be approved before integration when approval is required. Outstanding change requests remain unresolved and continue to block approval and integration.

If any integration is marked **adapted**, the Journey returns to in progress and needs a fresh compatibility declaration and submission. **Needs review**, incomplete dispositions, stale integration details, and merge conflicts fail without changing the Journey.

Reconciliation against an already-current main and integration cursor returns the existing revision without creating a commit or event or invalidating its approval.

The reconciliation response includes the current `status` and `manifestDeclared` fields. Existing clients can continue reading its `revision`. No stored-state or schema migration is required.

## Recover Journeys reset by the earlier behavior

Earlier reconciliation returned submitted Journeys to in progress and cleared `manifestDeclared`, while retaining the declaration's content. After this fix is deployed, verify that the existing declaration still describes the reconciled work, save it again (or explicitly declare no breaking changes), and submit the current reconciled revision. Acquiring editing locks is unnecessary for these steps.

Recovery does not restore earlier approvals. When approval is required, a reviewer must approve the current exact revision before integration.
