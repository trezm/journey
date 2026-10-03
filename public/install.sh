#!/usr/bin/env bash
# Install the existing Journey CLI. Keep all work inside the function so a
# truncated curl download cannot execute a partially received installation.
journey_install() (
  set -euo pipefail

  fail() { printf 'Journey installer: %s\n' "$*" >&2; exit 1; }
  usage() {
    cat <<'HELP'
Install Journey's existing CLI (macOS, Linux, or WSL).
Requires Bash, curl, Node.js 22+, and Git. No sudo or npm install.

  bash install.sh [--url HTTPS_ORIGIN] [--prefix ABSOLUTE_DIRECTORY]

Default origin: https://journey.peter-s-mertz.workers.dev
Default prefix: $HOME/.local
Installs bin/journey and lib/journey/journey.mjs below the prefix.
Rerun the same command to update. Credentials and shell profiles stay intact.
HTTP is accepted only for loopback development servers.
HELP
  }

  local origin='https://journey.peter-s-mertz.workers.dev'
  local prefix="${HOME:?HOME must be set}/.local"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --url|--prefix)
        [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $1."
        if [ "$1" = --url ]; then origin="$2"; else prefix="$2"; fi
        shift 2 ;;
      --help|-h) usage; return 0 ;;
      *) fail "Unknown option: $1. Run with --help." ;;
    esac
  done
  local tool
  for tool in node git curl; do
    command -v "$tool" >/dev/null 2>&1 || fail "Install $tool first, then rerun this command (Node.js 22+ and Git are required)."
  done
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail 'Node.js 22+ is required. Update Node.js, then rerun.'
  git --version >/dev/null 2>&1 || fail 'Git is installed but cannot run. Complete its setup, then rerun.'
  origin=$(node --input-type=module - "$origin" "$prefix" <<'VALIDATE'
import { isAbsolute } from 'node:path';
try {
  const url = new URL(process.argv[2]);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Use an HTTPS origin without a path, query, or credentials (HTTP loopback is allowed for development).');
  if (!isAbsolute(process.argv[3])) throw new Error('--prefix must be an absolute directory.');
  console.log(url.origin);
} catch (error) { console.error(`Journey installer: ${error.message}`); process.exit(1); }
VALIDATE
  )

  local temporary status
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/journey-install.XXXXXX")
  trap 'rm -rf -- "$temporary"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf 'Downloading Journey CLI from %s...\n' "$origin"
  # Do not follow login redirects or forward any authentication material.
  status=$(curl --proto '=https,http' --fail --silent --show-error \
    --connect-timeout 15 --max-time 120 --retry 2 --retry-delay 1 \
    --output "$temporary/journey.mjs" --write-out '%{http_code}' \
    --url "$origin/journey.mjs") || fail 'Download failed; the existing installation was preserved.'
  [ "$status" = 200 ] || fail "Expected HTTP 200, received $status. The host must serve /journey.mjs without a login redirect."
  [ -s "$temporary/journey.mjs" ] || fail 'The host returned an empty CLI.'
  local first_line
  IFS= read -r first_line < "$temporary/journey.mjs" || fail 'The host returned an incomplete CLI.'
  [ "$first_line" = '#!/usr/bin/env node' ] || fail 'The host did not return the Journey CLI. Check public asset access; a login page cannot be installed.'
  node --check "$temporary/journey.mjs" >/dev/null 2>&1 || fail 'The downloaded CLI is invalid or incomplete; the existing installation was preserved.'

  node --input-type=module - "$temporary/journey.mjs" "$prefix" <<'INSTALL'
import { lstatSync, mkdirSync, mkdtempSync, copyFileSync, chmodSync, readlinkSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const source = process.argv[2], prefix = resolve(process.argv[3]);
const bin = join(prefix, 'bin'), lib = join(prefix, 'lib'), directory = join(lib, 'journey');
const executable = join(bin, 'journey'), payload = join(directory, 'journey.mjs');
const info = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
let stagedPayload, stagedLink;
try {
  for (const path of [prefix, bin, lib, directory]) {
    const entry = info(path);
    if (entry && !entry.isDirectory()) throw new Error(`Refusing to install through a non-directory or symlink: ${path}`);
  }
  const existing = info(executable), existingPayload = info(payload);
  if (existing && (!existing.isSymbolicLink() || resolve(bin, readlinkSync(executable)) !== payload))
    throw new Error(`An unrelated command already exists at ${executable}. Choose another --prefix or move it yourself.`);
  if (existingPayload && !existingPayload.isFile()) throw new Error(`Refusing to replace a non-file or symlink: ${payload}`);
  if (existingPayload && !existing) throw new Error(`Unmanaged CLI found at ${payload}. Choose another --prefix or move it yourself.`);
  mkdirSync(bin, { recursive: true });
  mkdirSync(directory, { recursive: true });
  // Both staged files live on their destination filesystem. The CLI becomes
  // executable only after validation; rename replaces it atomically on update.
  stagedPayload = mkdtempSync(join(directory, '.install-'));
  const replacement = join(stagedPayload, 'journey.mjs');
  copyFileSync(source, replacement);
  chmodSync(replacement, 0o755);
  if (!existing) {
    stagedLink = mkdtempSync(join(bin, '.journey-install-'));
    symlinkSync(payload, join(stagedLink, 'journey'));
  }
  renameSync(replacement, payload);
  if (stagedLink) renameSync(join(stagedLink, 'journey'), executable);
  console.log(`Journey installed: ${executable}`);
} catch (error) { console.error(`Journey installer: ${error.message}`); process.exitCode = 1; }
finally {
  if (stagedPayload) rmSync(stagedPayload, { recursive: true, force: true });
  if (stagedLink) rmSync(stagedLink, { recursive: true, force: true });
}
INSTALL

  case ":${PATH:-}:" in
    *":$prefix/bin:"*) printf 'Run: journey --help\n' ;;
    *) printf '\nAdd Journey to this terminal, then run journey --help:\n  export PATH=%q:"$PATH"\n' "$prefix/bin"
       printf 'Add that export to your shell profile for future terminals.\n' ;;
  esac
  printf 'Next: journey connect journey-connection.json\nRerun this installer to update; repository connections and active checkouts are preserved.\n'
)

journey_install "$@"
