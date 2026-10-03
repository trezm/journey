#!/usr/bin/env node
// Journey CLI: Node.js 22+ and Git. No package installation required.
import { readFile, writeFile, mkdir, chmod, copyFile, stat, lstat, appendFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
const self = fileURLToPath(import.meta.url), argv = process.argv.slice(2), command = argv.shift() ?? 'help';
const say = data => console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const configHome = process.env.JOURNEY_CONFIG_HOME ?? join(homedir(), '.config', 'journey');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const git = (dir, args, options = {}) => execFileSync('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
let connection, workspace, profile;
async function privateJSON(path, value) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600); }
async function load() {
    try { workspace = JSON.parse(await readFile(resolve('.journey/config.json'), 'utf8')); } catch {}
    profile = process.env.JOURNEY_CONNECTION ?? workspace?.connection;
    if (!profile) { try { profile = (await readFile(join(configHome, 'active'), 'utf8')).trim(); } catch {} }
    if (!profile) throw new Error('Download a connection in Journey, then run: node journey.mjs connect journey-connection.json');
    connection = JSON.parse(await readFile(profile, 'utf8'));
    if (!connection.url || !connection.project || !connection.token) throw new Error('Invalid Journey connection file.');
}
function headers(c = connection) { return { Authorization: `Bearer ${c.token}`, ...(c.siteToken ? { 'OAI-Sites-Authorization': `Bearer ${c.siteToken}` } : {}) }; }
async function http(path, init = {}, c = connection) {
    let response;
    for (let i = 0; i < 3; i++) {
        try { response = await fetch(c.url.replace(/\/$/, '') + path, { ...init, headers: { ...headers(c), ...init.headers }, redirect: 'error' }); }
        catch (e) { if (i === 2) throw e; await sleep(300 * (i + 1)); continue; }
        if (response.status >= 500 && i < 2) { await response.arrayBuffer(); await sleep(300 * (i + 1)); continue; }
        let data; try { data = await response.json(); } catch { throw new Error(`Journey returned HTTP ${response.status}. Download a fresh connection if access has changed.`); }
        if (!response.ok) throw new Error(`${data.code ?? response.status}: ${data.error ?? 'Request failed'}`);
        return data.result ?? data;
    }
}
function get(query = {}, c = connection) { return http('/api/avc?' + new URLSearchParams({ project: c.project, ...query }), {}, c); }
function post(body, c = connection) { const payload = JSON.stringify({ project: c.project, requestId: crypto.randomUUID(), ...body }); return http('/api/avc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }, c); }
function importer(op, session, body) { return http('/api/import?' + new URLSearchParams({ project: connection.project, op, ...(session ? { session } : {}) }), { method: 'POST', ...(body ? { body, headers: { 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' } } : {}) }); }
function gitEnv(c = connection) {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: c.siteToken ? '5' : '4', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('journey:' + c.token).toString('base64'), GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '', GIT_CONFIG_KEY_3: 'http.extraHeader', GIT_CONFIG_VALUE_3: '', ...(c.siteToken ? { GIT_CONFIG_KEY_4: 'http.extraHeader', GIT_CONFIG_VALUE_4: 'OAI-Sites-Authorization: Bearer ' + c.siteToken } : {}) };
}
// Set the clearing header first; subsequent headers append. Credentials stay in process environment.
function authenticatedGit(dir, args, c = connection) { const env = gitEnv(c); env.GIT_CONFIG_KEY_0 = 'http.extraHeader'; env.GIT_CONFIG_VALUE_0 = ''; env.GIT_CONFIG_KEY_3 = 'http.extraHeader'; env.GIT_CONFIG_VALUE_3 = 'Authorization: Basic ' + Buffer.from('journey:' + c.token).toString('base64'); return git(dir, args, { env }); }
const instructions = `# Journey agent workflow

Use Node.js 22+ and Git. Run commands from this checkout: node .journey/journey.mjs help.
Connection credentials are local, excluded from Git. Never print them, add them to commits, or put them in prompts.
Follow the repository's existing AGENTS.md instructions too.

Coordinator: for each independent task, run node .journey/journey.mjs start "Task title" /absolute/path/to/task-worktree.
This issues a separate worker credential, creates a journey, clones an isolated checkout, and starts its lease/inbox watcher.
Then spawn one agent per task with that checkout as its working directory. Tell each agent to read its .journey/AGENTS.md.
You orchestrate agent spawning in Codex; Journey coordinates their work. If your Codex session lacks spawning tools, say so instead of claiming parallel execution.
Each journey should implement a complete feature. Changesets describe implementation steps; patches are immutable corrections.

Worker workflow:
1. node .journey/journey.mjs changeset "What this step accomplishes"
2. BEFORE editing, node .journey/journey.mjs lock CHANGESET path/to/file START END
   Use 1-based inclusive lines at the current journey hash. Add --whole for file creation/deletion or whole-file work.
   Multiple locks: node .journey/journey.mjs locks CHANGESET scopes.json (array of {path,start,end,whole}).
   A queued response is NOT permission to edit. Watch .journey/inbox.jsonl for lock.available, then retry acquisition.
   Acquire all needed scopes together to avoid waiting while partially holding conflicting locks.
3. Edit only granted scopes. Run optional build/tests for the feature. CI is not a protocol requirement.
4. node .journey/journey.mjs publish CHANGESET "Patch description" publishes local text edits/deletions using current lock tokens.
   Patches retain executable bits and preserve untouched binaries, symlinks, submodules and history.
   Binary edits, mode changes and large text edits are unsupported in this initial release; report them explicitly.
   Each successful publication updates this checkout's local Git head while retaining any remaining working edits.
5. node .journey/journey.mjs run "Why this check matters" -- <executable> <args...> captures command output and exit code.
   node .journey/journey.mjs record explanation "Why this decision was made" records an explanation (mark reconstructed explicitly via request if needed).
6. Read node .journey/journey.mjs inbox and .journey/inbox.jsonl, including reviews and accepted journeys' breaking changes.
   Before submission, reconcile every new integration. Save dispositions.json mapping event IDs to unaffected, adapted or needs_review.
   node .journey/journey.mjs reconcile dispositions.json requires a clean published checkout; review merged code after it runs.
   A submitted journey remains in review with its declaration when every new integration is unaffected. A new revision still needs fresh approval.
   Submitting published work for review does not require editing locks. Publication and integration still require valid locks.
7. node .journey/journey.mjs manifest breaking.json with an array of {target,kind,before,after,migration}, or [] to explicitly declare none.
8. node .journey/journey.mjs submit. Human approval is required by default; agents cannot approve themselves.
9. Respond to review requests (request JSON can resolve_review). New patches/declarations invalidate approval.
10. node .journey/journey.mjs integrate returns every current lock and checks the exact approved hash and latest main/cursor.

The automatically started watcher refreshes leases every 60 seconds and polls events every 5 seconds.
Check .journey/watcher.log for errors. A failed/expired lease must be reacquired before publication; never assume a notification grants it.
Watcher stops when the journey integrates or is abandoned. node .journey/journey.mjs watch --background restarts it.
node .journey/journey.mjs abandon closes this journey and returns locks.
For other API actions: node .journey/journey.mjs request request.json. The CLI supplies project and a retry-stable requestId.
Imported committed local branches and tags are retained (a differing source main is also retained as imported/main); uncommitted edits are not uploaded by import.
`;
async function setup(dir, connectionPath = profile, journey) {
    dir = resolve(dir); git(dir, ['rev-parse', '--show-toplevel']);
    if (git(dir, ['ls-files', '.journey'], { encoding: 'utf8' }).trim()) throw new Error('The repository already tracks .journey content. Setup stopped to preserve it; choose a checkout without that reserved directory.');
    const existing = await lstat(join(dir, '.journey')).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('Setup refuses to write through a .journey symlink.');
    const prior = JSON.parse(await readFile(join(dir, '.journey/config.json'), 'utf8').catch(() => '{}'));
    if (existing && !prior.connection) {
        for (const name of ['config.json', 'AGENTS.md', 'CODEX_PROMPT.md', 'journey.mjs']) if (await lstat(join(dir, '.journey', name)).catch(() => null)) throw new Error('Existing .journey setup files were found. Setup stopped to preserve them.');
    }
    await mkdir(join(dir, '.journey'), { recursive: true, mode: 0o700 });
    if (resolve(self) !== join(dir, '.journey/journey.mjs')) await copyFile(self, join(dir, '.journey/journey.mjs'));
    try { await writeFile(join(dir, '.journey/AGENTS.md'), instructions, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await privateJSON(join(dir, '.journey/config.json'), { connection: resolve(connectionPath), ...(journey ? { journey } : {}) });
    const exclude = resolve(dir, git(dir, ['rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim());
    await mkdir(dirname(exclude), { recursive: true }); const old = await readFile(exclude, 'utf8').catch(() => '');
    if (!old.split('\n').includes('/.journey/')) await appendFile(exclude, '\n/.journey/\n');
    const prompt = `Read .journey/AGENTS.md. Here are my tasks:\n\n1. [Task one]\n2. [Task two]\n\nCreate a Journey checkout for each independent task and spawn agents to accomplish them in parallel. Each agent must acquire locks before editing, record described patches, run relevant checks, declare breaking changes, and submit its complete journey for my review. Monitor the inbox for requests and integrations.\n`;
    try { await writeFile(join(dir, '.journey/CODEX_PROMPT.md'), prompt, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return dir;
}
async function active() { if (!workspace?.journey) throw new Error('This is a coordinator checkout. Run start <title> <new-directory> to create an isolated task journey.'); const { state } = await get(); const j = state.journeys.find(j => j.id === workspace.journey); if (!j) throw new Error('Journey not found.'); return { state, j, tokens: state.leases.filter(l => l.journey === j.id && l.token).map(l => l.token) }; }
function dirtyPaths() { return [...new Set([...git('.', ['diff', '--name-only', '-z', 'HEAD']).toString('utf8').split('\0'), ...git('.', ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0')].filter(Boolean))]; }
async function syncHead(head, hard = false) { authenticatedGit('.', ['fetch', '--quiet', 'origin', `refs/heads/journeys/${workspace.journey}`]); git('.', ['reset', hard ? '--hard' : '--mixed', head]); }
async function watch() {
    const directory = resolve('.journey');
    if (argv.includes('--background')) {
        const pidPath = join(directory, 'watcher.pid');
        try { const pid = Number(await readFile(pidPath, 'utf8')); process.kill(pid, 0); return say({ watcher: 'already running', pid }); } catch {}
        const child = spawn(process.execPath, [self, 'watch'], { cwd: process.cwd(), detached: true, stdio: 'ignore', env: { ...process.env, JOURNEY_CONNECTION: profile } }); child.unref();
        await writeFile(pidPath, String(child.pid), { mode: 0o600 }); return say({ watcher: 'started', pid: child.pid });
    }
    let cursor = Number(await readFile(join(directory, 'cursor'), 'utf8').catch(() => '0')), refreshed = 0;
    for (;;) {
        try {
            const { state, j, tokens } = await active();
            if (['integrated', 'abandoned'].includes(j.status)) break;
            if (Date.now() - refreshed >= 60000 && tokens.length) { await post({ action: 'refresh', journey: j.id, tokens }); refreshed = Date.now(); }
            const inbox = await get({ journey: j.id, since: String(cursor) });
            for (const event of inbox.events) await appendFile(join(directory, 'inbox.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
            // Append first and persist cursor second: after a crash events may repeat, but are not lost.
            cursor = inbox.cursor; await writeFile(join(directory, 'cursor'), String(cursor), { mode: 0o600 });
            const waits = state.waiting.filter(w => w.journey === j.id).length;
            await writeFile(join(directory, 'watcher.log'), `${new Date().toISOString()} polling; ${tokens.length} locks; ${waits} waiting requests\n`, { mode: 0o600 });
        } catch (e) { await appendFile(join(directory, 'watcher.log'), `${new Date().toISOString()} ERROR ${e.message}\n`, { mode: 0o600 }); }
        await sleep(5000);
    }
    await unlink(join(directory, 'watcher.pid')).catch(() => {});
}
async function importRepo(dir) {
    dir = resolve(dir); const format = git(dir, ['rev-parse', '--show-object-format'], { encoding: 'utf8' }).trim();
    if (format !== 'sha1') throw new Error('This release supports SHA-1 Git repositories.');
    if (git(dir, ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') throw new Error('Run git fetch --unshallow before importing.');
    const refs = Object.fromEntries(git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/tags/'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => line.split(' ')));
    const head = git(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const oids = [...new Set(git(dir, ['rev-list', '--objects', '--no-object-names', head, ...Object.values(refs)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean))];
    if (oids.length > 50000 || Object.keys(refs).length > 1000) throw new Error('Import limit: 50,000 Git objects and 1,000 local branches/tags.');
    const sizes = git(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: oids.join('\n') + '\n', encoding: 'utf8' }).trim().split('\n').map(line => line.split(' '));
    if (sizes.some(a => Number(a[2]) > 19_999_000)) throw new Error('Import limit: each Git object must be smaller than 20 MB.');
    if (sizes.reduce((sum, a) => sum + Number(a[2]), 0) > 300_000_000) throw new Error('Import limit: 300 MB of uncompressed reachable objects.');
    const status = git(dir, ['status', '--porcelain'], { encoding: 'utf8' });
    if (status) console.error('Import includes committed history only. Your uncommitted changes remain on local disk.');
    console.error(`Importing ${oids.length} objects and ${Object.keys(refs).length} local branches/tags; current HEAD becomes Journey main.`);
    const session = (await importer('start')).id;
    let frames = [], bytes = 0, uploaded = 0;
    async function flush() { if (!frames.length) return; const count = frames.length; await importer('objects', session, Buffer.concat(frames)); uploaded += count; console.error(`${uploaded}/${oids.length} Git objects uploaded`); frames = []; bytes = 0; }
    for (const [oid, type] of sizes) {
        const body = git(dir, ['cat-file', type, oid]); const compressed = deflateSync(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));
        const frame = Buffer.alloc(44); frame.write(oid, 0, 'ascii'); frame.writeUInt32BE(compressed.length, 40);
        if (frames.length >= 128 || bytes + frame.length + compressed.length > 6_000_000) await flush();
        frames.push(Buffer.concat([frame, compressed])); bytes += 44 + compressed.length;
    }
    await flush(); const result = await importer('finish', session, JSON.stringify({ head, refs })); await setup(dir); say({ ...result, localDirectory: dir, next: `Open Codex in ${dir} and use .journey/CODEX_PROMPT.md` });
}
const help = `Journey CLI — Node.js 22+ and Git; no npm install\n\nconnect <downloaded-connection.json>     Store a repository credential privately\nimport <existing-local-git-directory>    Upload committed local history, branches and tags\nsetup <git-directory>                   Add excluded .journey commands and Codex instructions\nclone <new-directory>                   Clone imported repository and add instructions\nstart <title> <new-directory>            Create worker credential, journey and isolated checkout\nstate | status                          Inspect repository or current journey\nchangeset <description>                 Create a described implementation step\nlock <changeset> <path> <start> <end> [--whole]\nlocks <changeset> <scopes.json>          Acquire multiple scopes atomically\npublish <changeset> <description>       Publish all local text edits with current leases\npatch <changeset> <path> <description>\nrun <description> -- <command> [args]    Capture command output and exit code\nrecord <explanation|decision> <text>     Record a captured explanation or decision\nmanifest <breaking.json>                Declare breaking changes (or [] explicitly)\nsubmit | integrate | abandon            Current journey lifecycle\ninbox [cursor] | watch [--background]   Review/availability inbox and renewable leases\nreconcile <dispositions.json>            Merge latest main after assessing events\nrequest <request.json>                  Any protocol action; IDs supplied automatically\nprotocol                               Print the complete agent contract\n\nDownload a new connection to switch repositories; connect selects it.\nCredentials stay in ~/.config/journey (mode 600). .journey/ is locally excluded from Git.\nParallel agents use separate start directories and credentials.\n`;
try {
    if (command === 'help' || command === '--help') say(help);
    else if (command === 'protocol') say(instructions);
    else if (command === 'connect') {
        const source = resolve(argv[0] ?? 'journey-connection.json'), data = JSON.parse(await readFile(source, 'utf8'));
        const url = new URL(data.url); if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Connections require HTTPS.');
        if (!/^[a-f0-9-]{36}$/.test(data.project) || !data.token) throw new Error('Invalid Journey connection.');
        const path = join(configHome, data.project + '.json'); await privateJSON(path, data); await writeFile(join(configHome, 'active'), path, { mode: 0o600 }); await chmod(source, 0o600);
        connection = data; await get(); say({ connected: data.name, project: data.project, next: 'node journey.mjs import /path/to/existing/repository' });
    } else {
        await load();
        if (command === 'import') await importRepo(argv[0]);
        else if (command === 'setup') say({ directory: await setup(argv[0] ?? '.'), prompt: '.journey/CODEX_PROMPT.md' });
        else if (command === 'clone') {
            const directory = resolve(argv[0]); authenticatedGit('.', ['clone', '--quiet', connection.url + '/api/git/' + connection.project + '/', directory]); await setup(directory); say({ directory });
        } else if (command === 'start') {
            const [title, destination] = argv; if (!title || !destination) throw new Error('Usage: start "Task title" /new/worktree/directory');
            const directory = resolve(destination); if (await stat(directory).catch(() => null)) throw new Error('Use a new directory for each task.');
            const child = await post({ action: 'delegate_agent', name: title.slice(0, 80) }); const c = { ...connection, token: child.token };
            const j = await post({ action: 'create_journey', title, description: title }, c);
            const childProfile = join(configHome, 'agents', j.journey + '.json'); await privateJSON(childProfile, c);
            try {
                authenticatedGit('.', ['clone', '--quiet', c.url + '/api/git/' + c.project + '/', directory], c);
                const { state } = await get({}, c), journey = state.journeys.find(x => x.id === j.journey); git(directory, ['checkout', '--quiet', '-b', 'journey/' + j.journey, journey.base]);
                await setup(directory, childProfile, j.journey);
                execFileSync(process.execPath, [join(directory, '.journey/journey.mjs'), 'watch', '--background'], { cwd: directory, env: { ...process.env, JOURNEY_CONNECTION: childProfile }, stdio: 'pipe' });
            } catch (e) { console.error(`Journey ${j.journey} was created; checkout failed. Inspect state or abandon it with request. Never print the connection file.`); throw e; }
            say({ journey: j.journey, directory, agentInstructions: join(directory, '.journey/AGENTS.md') });
        } else if (command === 'state') say(await get());
        else if (command === 'request') say(await post({ ...(workspace?.journey ? { journey: workspace.journey } : {}), ...JSON.parse(await readFile(argv[0], 'utf8')) }));
        else if (command === 'watch') await watch();
        else {
            const { state, j, tokens } = await active();
            if (command === 'status') say({ journey: j, locks: state.leases.filter(l => l.journey === j.id).map(({ token, ...l }) => l), localChanges: dirtyPaths() });
            else if (command === 'changeset') say(await post({ action: 'create_changeset', journey: j.id, description: argv[0] }));
            else if (command === 'lock' || command === 'locks') {
                const scopes = command === 'locks' ? JSON.parse(await readFile(argv[1], 'utf8')) : [{ path: argv[1], start: Number(argv[2] ?? 1), end: Number(argv[3] ?? 1), whole: argv.includes('--whole') }];
                say(await post({ action: 'acquire', journey: j.id, changeset: argv[0], revision: j.head, scopes }));
            } else if (command === 'patch' || command === 'publish') {
                const paths = command === 'patch' ? [argv[1]] : dirtyPaths(), description = command === 'patch' ? argv[2] : argv[1];
                if (/(mode change|create mode (100755|120000|160000))/.test(git('.', ['diff', '--summary', 'HEAD'], { encoding: 'utf8' }))) throw new Error('File mode changes are not supported by the patch API yet.');
                const before = (await get({ revision: j.head })).files, edits = [];
                for (const path of paths) {
                    const info = await lstat(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
                    if (info && !info.isFile()) throw new Error(`Unsupported edit: ${path} is not a regular text file.`);
                    const raw = info ? await readFile(path) : null;
                    if (raw && (raw.length > 500000 || raw.includes(0))) throw new Error(`Unsupported edit: ${path} is binary or exceeds 500 KB.`);
                    const content = raw ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : null;
                    if (content !== (before[path] ?? null)) edits.push({ path, content });
                }
                if (!edits.length) throw new Error('No unpublished text changes.');
                const result = await post({ action: 'patch', journey: j.id, changeset: argv[0], revision: j.head, description, edits, tokens });
                await syncHead(result.revision); say(result);
            } else if (command === 'run') {
                const separator = argv.indexOf('--'); if (separator < 1 || !argv[separator + 1]) throw new Error('Usage: run "Description" -- command arguments');
                const program = argv[separator + 1], args = argv.slice(separator + 2);
                const captured = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
                const output = (captured.stdout ?? '') + (captured.stderr ?? '') + (captured.error ? '\n' + captured.error.message : '');
                const exitCode = Number.isInteger(captured.status) ? captured.status : 1;
                say(await post({ action: 'record', journey: j.id, kind: 'command', provenance: 'captured', description: argv[0], command: JSON.stringify([program, ...args]), output: output.slice(-12000), exitCode })); process.exitCode = exitCode ?? 1;
            } else if (command === 'record') say(await post({ action: 'record', journey: j.id, kind: argv[0], description: argv[1], provenance: 'captured' }));
            else if (command === 'manifest') say(await post({ action: 'declare_breaking', journey: j.id, changes: JSON.parse(await readFile(argv[0], 'utf8')) }));
            else if (command === 'inbox') say(await get({ journey: j.id, since: argv[0] ?? '0' }));
            else if (command === 'submit') { if (dirtyPaths().length) throw new Error('Publish local changes before submitting.'); say(await post({ action: 'submit', journey: j.id, revision: j.head, tokens })); }
            else if (command === 'integrate') say(await post({ action: 'integrate', journey: j.id, revision: j.head, head: state.head, cursor: state.integrationCursor, tokens }));
            else if (command === 'abandon') say(await post({ action: 'abandon', journey: j.id }));
            else if (command === 'reconcile') {
                if (dirtyPaths().length) throw new Error('Publish or save local changes before reconciliation.');
                const result = await post({ action: 'reconcile', journey: j.id, head: state.head, cursor: state.integrationCursor, dispositions: JSON.parse(await readFile(argv[0], 'utf8')) }); await syncHead(result.revision, true); say(result);
            } else throw new Error('Unknown command. Run help.');
        }
    }
} catch (e) { console.error(e.message); process.exitCode = 1; }
