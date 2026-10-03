# Deploy Journey to Cloudflare Workers

The production workspace is now `https://journey.peter-s-mertz.workers.dev`, using the configured `journey` D1 database and private `journey-git` R2 bucket. Its original repository history and existing agent credentials were copied and checked against a complete private source backup. Owner sign-in uses Cloudflare Access and the explicit verified owner mapping described below.

The former ChatGPT Site runs only the retirement handler in `build/sites-worker.ts`: browser navigation redirects to the Cloudflare origin, while old API, export and mutation requests return `410 site_moved`. It cannot read or write the preserved source storage. Keep the source database and bucket for rollback; do not redeploy the previous writable application without first pausing Cloudflare writes and reconciling all subsequent changes. Private connection profiles must use the Cloudflare origin and omit the obsolete `siteToken`; repository credentials remain unchanged.

Journey runs its interface, authentication, API and authenticated Git endpoint in one Cloudflare Worker. D1 stores accounts, sessions, agent credentials and repository protocol state. R2 stores Git objects, cached trees and snapshots. `wrangler.jsonc` is the checked-in source for bindings; the Cloudflare Vite plugin generates `dist/server/wrangler.json` during each build. Never edit generated configuration. No ChatGPT Site, connector service, platform identity header or platform service token is needed.

## Local development and verification

Use Node.js 22.13+ and the pinned pnpm version from `package.json` (for example, via Corepack).

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm cf:types
pnpm dev
```

Open `http://127.0.0.1:5173`, then create an email/password account. Local development uses simulated D1/R2 under `.wrangler/state`; the configured production resources are not contacted. The placeholder D1 ID in the checked-in configuration is for local development only. The compatibility date matches the pinned local Workers runtime. Upgrade the locked Cloudflare packages together before advancing the date to enable newer runtime behavior.

Verify the production bundle without publishing:

```sh
pnpm deploy:check
pnpm start --port 4173
```

With that local Worker running, in another terminal:

```sh
node tests/cloudflare-smoke.mjs
node tests/http-smoke.mjs
node tests/cli-smoke.mjs
node --experimental-strip-types --test tests/protocol.test.mjs
pnpm exec tsc --noEmit --incremental false
```

Both the Vite server and built Worker share the same local persistence path. `deploy:check` rebuilds and runs Wrangler's dry run without provisioning resources. `deploy` and `db:migrate:remote` refuse the placeholder D1 ID.

## First deployment with an empty workspace

If moving an existing Site with repositories, follow the migration section first. Creating fresh storage creates an empty workspace; it does not move existing data.

1. Sign into the Cloudflare account that will own the application:

   ```sh
   pnpm cf login
   pnpm cf whoami
   ```

   CI can instead use `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as protected environment variables. Grant Workers deployment plus D1/R2 permissions needed for the operations below. Never place the token in source, config or command arguments. Bindings do not require an application API token.

2. Provision D1 and R2, then save their actual names and the D1 UUID:

   ```sh
   pnpm cf d1 create journey
   pnpm cf r2 bucket create journey-git
   pnpm cf:configure --database-id YOUR_D1_UUID --database-name journey --bucket journey-git --name journey
   pnpm cf:check
   ```

   Replace `YOUR_D1_UUID` with the returned database ID. You can bind existing resources instead. `cf:configure` only updates local configuration; it does not create or deploy anything. Commit the non-secret resource configuration so subsequent builds use the same storage. Choose unique resource/Worker names if these names are already in use.

3. Apply migrations, verify and publish:

   ```sh
   pnpm db:migrate:remote
   pnpm cf:types
   pnpm deploy:check
   pnpm deploy
   ```

   The deploy command rebuilds before publishing the generated Worker and its client assets. Wrangler reports the `workers.dev` URL. Open it and create an account. The app does not require application secrets for email/password sessions or repository-scoped agent authentication.

4. To use a custom domain, add a `routes` entry to `wrangler.jsonc` and rebuild/redeploy:

   ```json
   "routes": [{ "pattern": "journey.example.com", "custom_domain": true }]
   ```

   The domain must be in the deploying Cloudflare account. Disable `workers_dev` if the custom domain should be the only public address. Download new connection profiles after choosing the final origin. For staging, use a separate Worker, database and bucket; named Wrangler environments need their own binding declarations and a matching `CLOUDFLARE_ENV` for the Vite build. Do not reuse production storage in staging.

Cloudflare Workers Builds or other CI should install with the frozen lockfile, then run `pnpm deploy:check` and `pnpm deploy`. For an already initialized database, do not blindly reapply the initial schema outside the migration ledger.

## Move existing Site data without losing repositories

A Site's managed D1/R2 resources are not automatically owned by your Cloudflare account. Obtain access to the existing resources or a complete SQL/object export from the current hosting operator before switching traffic. If those exports are unavailable, the migration remains blocked on that access; deploying fresh bindings will not show the imported Journey repository.

1. Pause writes and stop agent watchers during the final cutover. Export D1 schema and every row, including `projects.state`, accounts, sessions and agent digests. When the database is already accessible in your Cloudflare account, a backup can be exported with:

   ```sh
   pnpm cf d1 export SOURCE_DATABASE_NAME --remote --output /private/backup/journey.sql
   ```

   Keep database exports private: they contain credential hashes and full repository state. If existing D1/R2 resources are accessible in the target account, bind them directly with `cf:configure` and omit the copy. Otherwise import the SQL backup into an empty target database:

   ```sh
   pnpm cf d1 execute DB --remote --file /private/backup/journey.sql
   ```

2. Copy **all** R2 objects with their original keys and bytes using your operator's export/import or an S3-compatible bulk-copy tool. Keys include `PROJECT_ID/objects/XX/REST`, `PROJECT_ID/trees/SHA` and `PROJECT_ID/snapshots/SHA`; copying only rendered source files loses Git history, binaries and refs. Do not recompress/rewrite Git object bytes. Keep source data until the target repository clone passes `git fsck` and main/branches/tags match.

3. Check schema and migration tracking before running remote migrations:

   ```sh
   pnpm cf d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table'; PRAGMA table_info(agents);"
   pnpm cf d1 migrations list DB --remote
   ```

   An up-to-date exported schema contains `users`, `sessions`, `auth_attempts`, `projects`, `agents`, the `agents.role` column and `idx_projects_owner`. If the source applied the three current Drizzle SQL files without Wrangler's `d1_migrations` ledger, running them again would fail on existing tables/columns. Only after verifying the schema matches **all three** files, baseline those already-applied migrations with this administrative SQL (save it privately and execute via `pnpm cf d1 execute DB --remote --file PATH`):

   ```sql
   CREATE TABLE IF NOT EXISTS d1_migrations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT UNIQUE,
     applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
   );
   INSERT OR IGNORE INTO d1_migrations (name) VALUES
     ('0000_right_psynapse.sql'),
     ('0001_majestic_captain_universe.sql'),
     ('0002_volatile_exiles.sql');
   ```

   If only part of the schema exists, baseline only migrations whose exact changes are already present, then apply the remaining migrations. Future generated SQL files continue through `db:migrate:remote`. No repository metadata/Git format changes are required for this deployment migration.

4. Email/password owners retain their existing user IDs. Owners created through ChatGPT sign-in have `projects.owner` values starting with `siwc:` and need an explicit ownership mapping; public Workers intentionally ignore all `oai-authenticated-user-*` headers. After deploying the target, each intended owner registers an email/password account. As the authenticated database administrator, inspect the project and the registered user:

   ```sh
   pnpm cf d1 execute DB --remote --command "SELECT id,name,owner FROM projects; SELECT id,email FROM users;"
   ```

   Verify the person's identity using the existing hosting account or another trusted administrative record. Matching an unverified email address alone is insufficient. For each verified project/owner pair, save and execute SQL with the actual IDs replacing the three placeholders:

   ```sql
   UPDATE projects
   SET owner = 'REGISTERED_USER_UUID', version = version + 1
   WHERE id = 'EXACT_PROJECT_ID'
     AND owner = 'siwc:EXACT_OLD_PLATFORM_USER_ID'
     AND EXISTS (SELECT 1 FROM users WHERE id = 'REGISTERED_USER_UUID');
   SELECT changes() AS reassigned_projects;
   SELECT id,name,owner FROM projects WHERE id = 'EXACT_PROJECT_ID';
   ```

   Require exactly one updated row; investigate zero rather than broadening the filter. Repeat only for explicitly verified projects. Historical journey/review actor IDs stay unchanged for audit history. No public ownership-claim endpoint or automatic email-based takeover is introduced.

5. Open each migrated repository in the target, inspect its code and timeline, and clone it with a repository agent token. Validate main/branches/tags and `git fsck`. Switch the final domain only after validation. Keep the old SQL/object backups for rollback.

## Reconnect local agents after an origin change

Connection profiles store the absolute API origin. Existing profiles do not follow a Site-to-Workers move, and the CLI disables credential-bearing Git redirects. Pause the old watchers first. For a migrated repository, use **Connect & import** on the new host to download a new connection, then run:

```sh
node journey.mjs connect /private/path/journey-connection.json
node journey.mjs setup /absolute/path/to/existing/local/repository
```

The newly downloaded coordinator profile has the new origin and omits the obsolete Sites service token. Do not run `import` again on a repository whose D1/R2 data was migrated. Create new worker checkouts with `start` after reconnection. Existing worker credentials can keep their repository-scoped application tokens only if the old digests were migrated. With watchers stopped, update only their private connection profile URL and remove `siteToken`; preserve `.journey/config.json` and its existing journey ID. Do **not** rerun `setup` on an existing worker: that command clears its journey binding. Back up the existing CLI before copying a new downloaded `journey.mjs` into `.journey/` if an update is needed. Alternatively abandon/recreate the old journeys and revoke old tokens through the owner API. Keep profiles private and never print their contents. Restart watchers only against the new host, and reacquire leases that expired during cutover before publishing. Login cookies are scoped to the old origin, so humans sign in again after cutover.

## Operation and rollback

Use `pnpm cf tail` for Worker logs and monitor D1/R2 errors. Worker observability is enabled in config. Roll back code with `pnpm cf rollback` when required; rollback does not restore database or bucket contents. Back up storage before later schema migrations. Protect deployment tokens in CI and restrict Cloudflare administrative access. Registration currently has no email verification, mail delivery or password recovery; those remain application limitations, including on standalone hosting.

References: [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/reference/api/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Preserve an existing private owner through Cloudflare Access

A private deployment can use Cloudflare Access instead of creating a password account. Configure a self-hosted Access application for the final Worker hostname and previews, with an allow policy matching only the existing, independently verified owner email. The owner mapping below is administrative configuration; never infer it from a newly registered or unverified email. Compare every source project owner with the trusted original account record before enabling traffic.

Set `AVC_ACCESS_TEAM_DOMAIN` to the existing HTTPS team origin (for example `https://yourteam.cloudflareaccess.com`) and `AVC_ACCESS_AUD` to that application's audience tag. Store `AVC_ACCESS_OWNER_MAP` as a Worker secret containing a JSON object that maps each explicitly verified Access email to its exact existing owner ID, for example `{"owner@example.com":"siwc:EXACT_EXISTING_OWNER_ID"}`. Keep actual mapping values private. No account or repository ownership rows change, and historical actor identities remain intact. All three values must be present together. Partial configuration fails closed; password accounts and registration are disabled whenever Access mode is configured. Remove all three only when deliberately returning to password authentication.

The app validates the assertion signature against the configured team's official `/cdn-cgi/access/certs` endpoint, accepts only RS256 application tokens, verifies the exact issuer/audience and token times, and requires an explicitly mapped verified email. Raw identity headers and unsigned/foreign/service tokens cannot select an owner. Signing keys are bounded and cached for ten minutes, with throttled refresh for rotation. Requests fail closed if new keys cannot be verified.

For existing repository tools, create more-specific **Bypass** applications only for the exact `/api/avc` path (including its trailing-slash form if routed) and `/api/git/*`. These endpoints continue enforcing their application owner/session or repository-scoped bearer/Basic authentication; a bypass does not grant repository access. Do not bypass all `/api/*`, `/api/auth`, or `/api/connect`. The source does not currently provide `/api/mcp`, so no bypass is needed for it. Protect the root UI and every alternative hostname/preview with Access; hostname-only protection does not automatically protect other domains.

Browser requests to bypassed paths can use their `CF_Authorization` cookie, which receives the same full signature/claim checks as the injected assertion header. Verify this through the actual deployed hostname before cutover. An expired or missing cookie returns unauthorized; revisiting the protected root reauthenticates. Sign-out navigates to `/cdn-cgi/access/logout` to clear the Access session rather than merely removing an application cookie. Tokens remain stateless until their signed expiry, so do not treat browser logout as instantaneous revocation of a copied token.

Before opening traffic, confirm: anonymous and forged-header AVC/Git requests are rejected; the mapped owner can browse the migrated projects without password signup; an unmapped valid Access identity is rejected; existing agent credentials still clone/read their own repository and cannot cross repository boundaries; password registration is refused in Access mode; owner sign-out clears the Access session; and all roots, preview URLs and bypass paths enforce the intended policy.

References: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [Protect Workers with Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
