# Contributing to Journey

Bug reports, focused fixes, documentation improvements and feature proposals are welcome. Search [existing issues](https://github.com/trezm/journey/issues) before opening a new one. Describe the problem and expected behavior; for larger changes, discuss the design before investing in a large implementation. Be respectful and keep discussion about the work.

## Development

Use Node.js 22.13+ (Node 22 LTS recommended), Git and the pnpm version pinned in `package.json`. Fork and clone the repository, create a branch, and follow [Run locally](README.md#run-locally). No hosted Journey account or Cloudflare credentials are required for local development or ordinary pull requests. Local migrations create disposable storage under `.wrangler/state`; do not point tests at production data.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm dev
```

The interface uses React/vinext, with Worker routes in `worker.ts` and `app/api/`, protocol logic in `lib/avc/`, database definitions in `db/` and migrations in `drizzle/`. `public/journey.mjs` is the downloadable agent CLI. Third-party UI source in `components/ui/` and vendored files carry their own notices; preserve those notices and avoid unrelated regeneration.

## Validation

```sh
pnpm test
pnpm typecheck
pnpm deploy:check
```

`pnpm test` runs `tests/*.test.mjs` with Node's test runner and bounded concurrency. Some tests start disposable local HTTP/Workerd servers, so they need permission to bind localhost; they use local fixtures, not provider credentials. Smoke scripts named `*-smoke.mjs` are separate and require a running local Worker; see [Cloudflare verification](docs/cloudflare.md#local-development-and-verification). A dry run builds and checks the bundle without publishing or provisioning resources.

Run `pnpm lint` for lint feedback. The current baseline has legacy findings, so full lint is not yet a CI gate; avoid introducing new findings in changed code. Add a focused regression test for behavior changes, and include relevant checks or explain limitations in your pull request. Keep `pnpm-lock.yaml` consistent with dependency changes and use a frozen install in CI.

## Review and compatibility

Keep changes focused. Explain the concrete problem, resulting behavior, validation and any migration needed for API, configuration or stored-data changes. Do not rewrite Git history or remove compatibility paths without discussing the migration. Protocol changes must preserve lease fencing, exact-revision approvals, idempotency and isolation across accounts/repositories.

For a Journey-managed checkout, follow `AGENTS.md` and the local `.journey/AGENTS.md`: acquire scopes before edits, publish patches, reconcile integrations, declare breaking changes (or `[]`) and submit for review. Ordinary GitHub contributors use a branch and pull request instead; `.journey/` is private local state and must not be committed.

## Credentials and licensing

Do not commit `.dev.vars`, environment files, connection downloads, tokens, cookies, database exports, repository backups or logs containing private content. Use synthetic repositories in reports and tests. Follow [SECURITY.md](SECURITY.md) for vulnerabilities rather than disclosing exploit details publicly.

Contributions are made under the repository's existing [MIT license](LICENSE). Preserve existing copyright and third-party notices. Do not add assets, music or code you do not have permission to redistribute.
