# Install the Journey CLI

Journey's installer downloads the existing `journey.mjs` and makes it available as `journey`. It does not install npm packages or change the CLI protocol. Supported environments are macOS, Linux, and WSL with Bash, curl, **Node.js 22+**, and Git already installed.

## Install and connect

Use the copyable command in the repository's **Connect & import** panel. It uses the origin of the workspace you are viewing. The production command, after the rollout below, is:

```sh
curl -fsSL https://journey.peter-s-mertz.workers.dev/install.sh | bash
```

The default locations are `~/.local/bin/journey` (a symlink) and `~/.local/lib/journey/journey.mjs` (the original executable CLI). If `~/.local/bin` is not on your PATH, the installer prints an `export PATH=…` command. Run it in your current terminal and add it to your shell profile (`~/.zshrc` for zsh or `~/.bashrc` for interactive Bash). The installer cannot change its parent shell's PATH and does not edit your shell files.

```sh
journey --help
journey connect journey-connection.json
journey import /path/to/existing/repository
```

Download the connection separately from **Connect & import**. Keep it private and out of Git. For an already imported repository, use the existing `journey clone` or `journey setup` flow instead of importing again. The existing `.journey/AGENTS.md` and `.journey/CODEX_PROMPT.md` explain parallel agent work. Existing checkout-local commands remain valid.

For a different Journey host or installation prefix:

```sh
curl -fsSL https://journey.example.com/install.sh | bash -s -- \
  --url https://journey.example.com --prefix "$HOME/.local"
```

`--url` must be an HTTPS origin without a path, query, or credentials. HTTP loopback origins such as `http://127.0.0.1:4173` are allowed for local development. `--prefix` must be an absolute path. Run `bash install.sh --help` after downloading the installer for all options. To inspect it first:

```sh
curl -fsSL https://journey.peter-s-mertz.workers.dev/install.sh -o install.sh
less install.sh
bash install.sh
```

## Updates, failures, and removal

Rerun the same installer command and prefix to update to that host's current CLI. The installer stages the download, requires HTTP 200 and the Node shebang, checks JavaScript syntax, then atomically replaces the CLI file. Download errors, login redirects, HTML, and invalid JavaScript leave the prior installation intact. The host's HTTPS connection supplies transport authenticity; there is no separately signed release or version-pinning service.

An unrelated `journey` command at the destination is never replaced. Choose another prefix or resolve the collision yourself. The installer also refuses symlinks in its managed directories or payload. It does not run sudo, install runtimes, alter credentials, or edit repositories. Updates affect the global command; existing `.journey/journey.mjs` copies and running watchers retain their existing version. Do not rerun `setup` on an active worker checkout to update it: the existing setup command resets its journey binding.

To remove a default installation, first verify that these are the paths you installed, then remove its symlink and payload:

```sh
rm "$HOME/.local/bin/journey" "$HOME/.local/lib/journey/journey.mjs"
rmdir "$HOME/.local/lib/journey"
```

Adjust the prefix if needed. Connection profiles in `~/.config/journey` and checkout-local `.journey` directories are separate and remain available.

## Hosting and rollout

`public/install.sh` and the existing `public/journey.mjs` ship with the app's static assets. The checked-in Vite/Cloudflare build copies them into `dist/client`; the existing `pnpm deploy` workflow uploads them with the application. No package registry, new account, domain, or separate binary build is required. Build and test locally before deployment; use the [Cloudflare deployment guide](cloudflare.md) for the established release procedure.

**This source change alone does not deploy the files or change Cloudflare Access.** The current production host protects browser asset downloads with Access. Before advertising the curl command, the owner must permit anonymous reads of exactly `/install.sh` and `/journey.mjs` on the chosen host through narrow Access bypass applications, then deploy the reviewed feature. Keep the UI, `/api/connect`, authentication endpoints, and repository data protected. The installer never accepts browser cookies or access tokens and fails on a login redirect. Existing API authentication is unchanged. For another private host that cannot expose these two public code assets, retain its authenticated browser download workflow.

Check both anonymous responses through the actual hostname, without cookies or credentials:

```sh
curl -fsS -D - https://journey.peter-s-mertz.workers.dev/install.sh -o /tmp/journey-install.sh
curl -fsS -D - https://journey.peter-s-mertz.workers.dev/journey.mjs -o /tmp/journey-cli.mjs
bash -n /tmp/journey-install.sh
node --check /tmp/journey-cli.mjs
```

Require HTTP 200 and script content; a 302 login redirect is not success. Then test the copied UI command with a disposable HOME and a separate installation prefix. This is a rollout gate, not permission to change Access settings or deploy unrelated working-tree edits.

## Local validation

```sh
node --test tests/cli-installer.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
pnpm build
```

The installer tests use a local HTTP fixture and disposable directories, including real curl/Bash installation, normal `journey` invocation, updates, failure preservation, and checkout setup. They do not create accounts or use production credentials.
