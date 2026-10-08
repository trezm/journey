# Repository retry history storage

Completed API requests retain their exact request fingerprint and result forever. Small recent receipts stay in the repository state; once their combined payload reaches 256 KB, the next mutation archives up to 64 payload parts in `receipt_archive`. Large receipts are split across rows. Reads of repository state do not load the archive. A retry queries only its own project and actor/request key.

Only receipts from an already committed repository state enter the archive. The atomic archive batch finishes before a separate version-checked repository update removes those inline receipts. Failed batches preserve the original state. Lost version races safely retry the same immutable values; conflicting archive values fail closed. The maintenance update commits before the new user action, so a failed action does not prevent migration progress. Newly generated results stay inline until a later mutation has observed their committed state.

## Deploying

1. Back up the remote D1 database.
2. Apply `drizzle/0006_receipt_archive.sql` with `node scripts/cloudflare.mjs migrate-remote` before deploying the Worker.
3. Deploy the Worker. Existing repositories migrate automatically during normal mutations, including background synchronization. No history or idempotency results are deleted.
4. Check that state writes succeed and archived retries still return the original response.

Keep the archive table when rolling forward or changing application versions. **Do not roll back to a Worker that cannot read archived receipts after migration has begun.** Such a Worker could repeat a completed operation. A rollback requires retaining archive-aware receipt lookup or a separately planned restoration of all receipts while writes are stopped; restoring only an old state snapshot would lose newer work. Backups must include both `projects` and `receipt_archive`.

This change removes repeated lock-renewal results from live metadata growth. Existing bounds on actual repository history, events, and individual requests remain unchanged.
