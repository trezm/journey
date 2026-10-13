# Security policy

Journey is an MVP. Security fixes target the current `main` branch; older snapshots do not have a promised maintenance window. See the [documented limitations](README.md#mvp-boundaries), especially authentication, password recovery and repository storage limits, before deploying.

## Report a vulnerability privately

Visit [the repository Security page](https://github.com/trezm/journey/security). If **Report a vulnerability** is available, use GitHub's private vulnerability reporting form. Availability depends on repository settings and is not guaranteed by this file.

If that option is unavailable and you do not already have a verified private maintainer channel, open an [issue](https://github.com/trezm/journey/issues) asking for a private security contact. Include no vulnerability details, exploit, credentials or private repository content in that public request. Wait for a private channel before sharing sensitive information. Do not send details to an unverified email address.

Privately include the affected revision, deployment mode, minimal reproduction with synthetic data, impact and any suggested fix. Remove agent tokens, OAuth/provider secrets, Access assertions, cookies, ownership mappings and D1/R2 exports. Test only on systems and accounts you control. Response and fix times depend on maintainer availability; no SLA is promised.

## Hosting responsibilities

Operators own their Cloudflare resources, backups, provider applications and credentials. Keep R2 private, configure separate staging resources, preserve the encryption key for existing provider connections, and follow [deployment guidance](docs/cloudflare.md). Password mode currently lacks email verification and password recovery; Access mode requires an explicit verified owner mapping. Neither public repository visibility nor an Access bypass grants agent write access.

If credentials are exposed, revoke/rotate them at the issuing service and investigate affected access. Removing a file or adding an ignore rule does not remove secrets from Git history. Coordinate any history cleanup with maintainers; this policy does not authorize history rewriting.
