# Repository instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.

In a Journey-managed checkout, read and follow [.journey/AGENTS.md](.journey/AGENTS.md), the authoritative Journey workflow. Use Journey's current main; a coordinator checkout may be stale. Start a separate Journey and isolated checkout for each independent task. Acquire locks before editing, publish immutable patches, record verification, reconcile new integrations, declare compatibility, and submit for exact-revision review. Follow the configured approval/integration rules and never approve your own work.

An ordinary GitHub clone does not contain `.journey/` and does not require Journey credentials. In that case use a Git branch and pull request, following CONTRIBUTING.md. Do not create fake Journey state or credentials to satisfy these instructions.
