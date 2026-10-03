# Lock lifecycle

A draft Journey uses 10-minute editing leases. Its worker watcher renews those leases every 60 seconds while monitoring the inbox. If the watcher stops or the computer sleeps for more than 10 minutes, unposted draft locks can expire. An expired token grants no editing or integration rights; acquire the scopes again before publishing or posting the Journey.

**Submit for review officially posts a Journey.** Successful submission converts its valid locks into durable reservations. Those locks have no time limit: they remain held until that Journey is integrated or abandoned. Publishing an individual patch does not trigger this transition.

Posted locks stay held across approvals, change requests, additional patches and reconciliation, even when an adapted reconciliation returns the Journey to in progress. New scopes acquired by a previously posted Journey are also retained. Posting never revives expired tokens or acquires missing scopes. Publication, posting and integration check valid tokens and change coverage; the repository owner follows the same integration requirement as a worker.

The watcher stops renewing retained locks but continues monitoring reviews, lock availability and accepted Journeys. Browser polling, a running laptop and a keepalive process are unnecessary to preserve a posted reservation. The standalone `keepalive` command renews draft locks and exits with an explanation when every current lock is retained; use `poll` to monitor that Journey's inbox.

Integrating or abandoning a Journey releases all its locks and notifies waiting Journeys. A posted Journey cannot relinquish its reservations while remaining open. If its work will not be completed, abandon it so other work can proceed. A waiting notification is an invitation to retry acquisition, never permission to edit.

For existing Journeys, the server recognizes prior review submissions and retains surviving locks. It does not recreate locks that expired before this change. Reacquire those scopes once; they become durable when the Journey is already posted. If another Journey now holds a conflicting scope, wait for its integration or abandonment.

The API exposes `journey.posted` and `lease.retained`. Clients treat `retained: true` as authoritative regardless of the numeric `expires` field. That field remains a far-future numeric value for compatibility with older clients. Draft locks retain ordinary expiry timestamps. Retained lock tokens are still required and must never be printed or committed.
