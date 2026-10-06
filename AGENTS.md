# Repository instructions

This is a Journey-managed project. Before making changes, read and follow [.journey/AGENTS.md](.journey/AGENTS.md), the authoritative Journey workflow for this checkout.

Use Journey's current main as the starting point for work; a coordinator checkout may be stale. Start a separate Journey and isolated checkout for each independent feature or task, and inspect the code there before deciding what needs to change.

Use changesets to describe implementation steps. Acquire Journey locks before editing, edit only granted scopes, and publish immutable patches through Journey. Record relevant verification, review the inbox and reconcile new integrations, declare compatibility in a manifest, and submit the completed Journey for review. Follow the configured approval and integration rules; agents must never approve their own work.
