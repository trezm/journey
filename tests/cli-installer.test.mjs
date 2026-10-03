import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, lstat, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../public/install.sh', import.meta.url));
const sourceCLI = await readFile(new URL('../public/journey.mjs', import.meta.url), 'utf8');
const bash = '/bin/bash';
const executable = name => execFileSync(bash, ['--noprofile', '--norc', '-c', 'command -v "$1"', 'find-tool', name], { encoding: 'utf8' }).trim();
const curl = executable('curl'), git = executable('git');
const project = '12345678-1234-1234-1234-123456789012';

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'journey-installer-'));
    const home = join(directory, 'home'), prefix = join(home, '.local');
    await mkdir(home);
    const env = { ...process.env, HOME: home, JOURNEY_CONFIG_HOME: join(home, '.config/journey'), PATH: dirname(process.execPath) + ':' + process.env.PATH };
    delete env.JOURNEY_CONNECTION;
    delete env.BASH_ENV;
    delete env.ENV;
    const children = new Set(), requests = [];
    const response = { status: 200, body: sourceCLI, headers: {}, extraLength: 0 };
    const server = createServer(async (req, res) => {
        requests.push({ path: req.url, authorization: req.headers.authorization });
        try {
            if (req.url === '/install.sh') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(await readFile(installer));
            } else if (req.url === '/journey.mjs') {
                res.writeHead(response.status, { 'Content-Type': 'text/javascript', 'Content-Length': Buffer.byteLength(response.body) + response.extraLength, Connection: 'close', ...response.headers });
                res.end(response.body);
            } else if (req.url.startsWith('/api/avc?')) {
                res.writeHead(req.headers.authorization === 'Bearer installer-fixture-token' ? 200 : 401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ state: { journeys: [], leases: [] } }));
            } else {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<!doctype html><title>Login or missing page</title>');
            }
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(error.message);
        }
    });
    t.after(async () => {
        for (const child of children) child.kill('SIGTERM');
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = 'http://127.0.0.1:' + server.address().port;

    function run(command, args = [], options = {}) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
            children.add(child);
            let stdout = '', stderr = '';
            const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
            child.stdout.on('data', data => stdout += data);
            child.stderr.on('data', data => stderr += data);
            child.once('error', error => { clearTimeout(timeout); children.delete(child); reject(error); });
            child.once('close', (code, signal) => { clearTimeout(timeout); children.delete(child); resolve({ code, signal, stdout, stderr }); });
        });
    }
    const install = (args = [], options) => run(bash, ['--noprofile', '--norc', installer, '--url', url, ...args], options);
    const cli = (args = [], customPrefix = prefix, options = {}) => run('journey', args, { ...options, env: { ...env, ...options.env, PATH: join(customPrefix, 'bin') + ':' + (options.env?.PATH ?? env.PATH) } });
    return { directory, home, prefix, env, url, requests, response, run, install, cli };
}

function succeeds(result) { assert.equal(result.code, 0, result.stderr + result.stdout); assert.equal(result.signal, null); }
function fails(result) { assert.notEqual(result.code, 0, result.stderr + result.stdout); assert.equal(result.signal, null); }
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const payloadAt = prefix => join(prefix, 'lib/journey/journey.mjs');

test('hosted curl pipeline installs the existing CLI as a normal command without changing local configuration', async t => {
    const f = await fixture(t);
    const sentinels = ['.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.config/journey/active', '.config/journey/existing.json', '.journey/config.json'];
    for (const name of sentinels) {
        const path = join(f.home, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'Preserve this existing local configuration.\n', { mode: 0o600 });
    }
    const installed = await f.run(bash, ['--noprofile', '--norc', '-o', 'pipefail', '-c', '"$1" -fsS "$2/install.sh" | "$3" --noprofile --norc -s -- --url "$2"', 'install-fixture', curl, f.url, bash]);
    succeeds(installed);
    assert.deepEqual(f.requests.map(request => request.path), ['/install.sh', '/journey.mjs']);
    assert(f.requests.every(request => request.authorization === undefined));
    assert.equal(await readFile(payloadAt(f.prefix), 'utf8'), sourceCLI);
    assert.equal((await lstat(join(f.prefix, 'bin/journey'))).isSymbolicLink(), true);
    assert.equal(resolve(join(f.prefix, 'bin'), await readlink(join(f.prefix, 'bin/journey'))), payloadAt(f.prefix));
    assert.notEqual((await stat(payloadAt(f.prefix))).mode & 0o111, 0);
    const help = await f.cli(['--help']);
    succeeds(help);
    assert.match(help.stdout, /Journey CLI/);
    assert.match(help.stdout, /connect <downloaded-connection\.json>/);
    const pathExport = installed.stdout.split('\n').find(line => /^\s*export PATH=/.test(line));
    assert(pathExport, 'fresh-shell installation explains how to add the command to PATH');
    succeeds(await f.run(bash, ['--noprofile', '--norc', '-c', pathExport + '\njourney --help']));
    for (const name of sentinels) assert.equal(await readFile(join(f.home, name), 'utf8'), 'Preserve this existing local configuration.\n');
});

test('reinstall and upgrade replace only the managed payload and remain executable', async t => {
    const f = await fixture(t);
    succeeds(await f.install());
    const command = join(f.prefix, 'bin/journey'), link = await readlink(command);
    succeeds(await f.install());
    f.response.body = sourceCLI + '\n// Updated fixture release.\n';
    succeeds(await f.install());
    assert.equal(await readFile(payloadAt(f.prefix), 'utf8'), f.response.body);
    assert.equal(await readlink(command), link);
    assert.deepEqual(await readdir(join(f.prefix, 'lib/journey')), ['journey.mjs']);
    succeeds(await f.cli(['help']));
});

test('HTTP errors, redirects and invalid payloads leave the prior installation usable', async t => {
    const f = await fixture(t);
    succeeds(await f.install());
    const command = join(f.prefix, 'bin/journey'), originalLink = await readlink(command);
    const cases = [
        { name: '404 response', status: 404, body: 'Not found' },
        { name: 'authentication redirect', status: 302, body: '', headers: { Location: '/login' } },
        { name: 'partial status', status: 206, body: sourceCLI },
        { name: 'empty body', body: '' },
        { name: 'login HTML returned with 200', body: '<!doctype html><title>Sign in</title>' },
        { name: 'unexpected executable format', body: 'console.log("not the Journey CLI");\n' },
        { name: 'incomplete JavaScript', body: '#!/usr/bin/env node\nconst unfinished = (\n' },
        { name: 'truncated transfer', body: sourceCLI, extraLength: 30 },
    ];
    for (const invalid of cases) await t.test(invalid.name, async () => {
        Object.assign(f.response, { status: 200, body: sourceCLI, headers: {}, extraLength: 0 }, invalid);
        fails(await f.install());
        assert.equal(await readFile(payloadAt(f.prefix), 'utf8'), sourceCLI);
        assert.equal(await readlink(command), originalLink);
        assert.deepEqual(await readdir(join(f.prefix, 'lib/journey')), ['journey.mjs']);
        succeeds(await f.cli(['--help']));
    });
    assert.equal(f.requests.some(request => request.path === '/login'), false, 'curl must not follow authentication redirects');
});

test('custom prefixes and printed PATH instructions safely handle spaces and shell metacharacters', async t => {
    const f = await fixture(t);
    const prefix = join(f.directory, 'prefix with spaces \' " $(touch INJECTED) ; `touch BACKTICK`');
    const installed = await f.install(['--prefix', prefix]);
    succeeds(installed);
    assert.equal(await readFile(payloadAt(prefix), 'utf8'), sourceCLI);
    succeeds(await f.cli(['--help'], prefix));
    const pathExport = installed.stdout.split('\n').find(line => /^\s*export PATH=/.test(line));
    assert(pathExport, 'custom-prefix install prints a usable PATH export');
    succeeds(await f.run(bash, ['--noprofile', '--norc', '-c', pathExport + '\njourney --help']));
    assert.equal(await exists(join(f.directory, 'INJECTED')), false);
    assert.equal(await exists(join(f.directory, 'BACKTICK')), false);
});

test('unmanaged commands and unexpected payload destinations are preserved', async t => {
    const f = await fixture(t);
    const outside = join(f.directory, 'unrelated-file');
    await writeFile(outside, 'unrelated content\n');
    for (const kind of ['command file', 'command directory', 'foreign command symlink', 'payload symlink', 'payload directory', 'payload file']) await t.test(kind, async () => {
        const prefix = join(f.directory, kind), command = join(prefix, 'bin/journey'), payload = payloadAt(prefix);
        await mkdir(dirname(command), { recursive: true });
        await mkdir(dirname(payload), { recursive: true });
        if (kind === 'command file') await writeFile(command, 'unrelated command\n', { mode: 0o755 });
        if (kind === 'command directory') await mkdir(command);
        if (kind === 'foreign command symlink') await symlink(outside, command);
        if (kind === 'payload symlink') await symlink(outside, payload);
        if (kind === 'payload directory') await mkdir(payload);
        if (kind === 'payload file') await writeFile(payload, 'unmanaged payload\n');
        const guarded = kind.startsWith('payload') ? payload : command;
        const before = await lstat(guarded);
        fails(await f.install(['--prefix', prefix]));
        const after = await lstat(guarded);
        assert.equal(after.ino, before.ino);
        assert.equal(after.mode, before.mode);
        assert.equal(await readFile(outside, 'utf8'), 'unrelated content\n');
        if (kind === 'command file') assert.equal(await readFile(command, 'utf8'), 'unrelated command\n');
        if (kind === 'payload file') assert.equal(await readFile(payload, 'utf8'), 'unmanaged payload\n');
        if (kind === 'foreign command symlink' || kind === 'payload symlink') assert.equal(await readlink(guarded), outside);
    });
});

test('missing prerequisites fail before fetching or writing an installation', async t => {
    const f = await fixture(t);
    for (const missing of ['node', 'git', 'curl']) await t.test(missing, async () => {
        const path = join(f.directory, 'tools-without-' + missing), prefix = join(f.directory, 'missing-' + missing);
        await mkdir(path);
        for (const [name, target] of Object.entries({ node: process.execPath, git, curl, uname: executable('uname'), dirname: executable('dirname'), mkdir: executable('mkdir'), mktemp: executable('mktemp'), head: executable('head'), sed: executable('sed'), tr: executable('tr'), rm: executable('rm') })) {
            if (name !== missing) await symlink(target, join(path, name));
        }
        const result = await f.install(['--prefix', prefix], { env: { ...f.env, PATH: path } });
        fails(result);
        assert.match(result.stderr + result.stdout, new RegExp(missing, 'i'));
        assert.equal(await exists(payloadAt(prefix)), false);
    });
    assert.equal(f.requests.length, 0);
});

test('help and rejected arguments perform no downloads or installation', async t => {
    const f = await fixture(t);
    const helpTools = join(f.directory, 'help-tools');
    await mkdir(helpTools);
    await symlink(executable('cat'), join(helpTools, 'cat'));
    const help = await f.run(bash, ['--noprofile', '--norc', installer, '--help'], { env: { ...f.env, PATH: helpTools } });
    succeeds(help);
    assert.match(help.stdout, /--prefix/);
    assert.match(help.stdout, /--url/);
    // If URL validation regresses, fail hermetically instead of contacting any
    // external host or reading a file:// target through real curl.
    const sentinel = join(f.directory, 'unexpected-curl');
    await writeFile(join(helpTools, 'curl'), '#!/bin/sh\nprintf called > "$JOURNEY_CURL_SENTINEL"\nexit 97\n', { mode: 0o755 });
    for (const args of [['--unknown'], ['--prefix'], ['--url'], ['--prefix', 'relative/path'], ['--url', 'http://example.com'], ['--url', 'file:///tmp/cli'], ['--url', 'https://example.com/path'], ['--url', 'https://example.com?query=1']]) {
        fails(await f.install(args, { env: { ...f.env, PATH: helpTools + ':' + f.env.PATH, JOURNEY_CURL_SENTINEL: sentinel } }));
    }
    assert.equal(await exists(sentinel), false);
    assert.equal(f.requests.length, 0);
    assert.equal(await exists(f.prefix), false);
});

test('an unsupported Node version probe and unusable Git stop before downloading', async t => {
    const f = await fixture(t);
    for (const name of ['node', 'git']) await t.test(name, async () => {
        const tools = join(f.directory, 'unusable-' + name), prefix = join(f.directory, 'unsupported-' + name);
        await mkdir(tools);
        // Simulate Node rejecting the minimum-version probe, or Git being
        // present on PATH while its platform setup is incomplete.
        await writeFile(join(tools, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const result = await f.install(['--prefix', prefix], { env: { ...f.env, PATH: tools + ':' + f.env.PATH } });
        fails(result);
        assert.match(result.stderr + result.stdout, name === 'node' ? /Node\.js 22\+/ : /Git.*cannot run/);
        assert.equal(await exists(prefix), false);
    });
    assert.equal(f.requests.length, 0);
});

test('installed CLI connects and copies its actual module into repository setup', async t => {
    const f = await fixture(t);
    succeeds(await f.install());
    const connection = join(f.directory, 'downloaded-connection.json');
    await writeFile(connection, JSON.stringify({ url: f.url, project, token: 'installer-fixture-token', name: 'Installer fixture' }));
    succeeds(await f.cli(['connect', connection]));
    assert.equal((await stat(join(f.env.JOURNEY_CONFIG_HOME, project + '.json'))).mode & 0o777, 0o600);
    const repository = join(f.directory, 'existing repository');
    await mkdir(repository);
    succeeds(await f.run(git, ['init', '--quiet', repository]));
    succeeds(await f.cli(['setup', repository]));
    const copiedCLI = join(repository, '.journey/journey.mjs');
    assert.equal(await readFile(copiedCLI, 'utf8'), sourceCLI);
    const copiedHelp = await f.run(copiedCLI, ['--help'], { cwd: repository });
    succeeds(copiedHelp);
    assert.match(copiedHelp.stdout, /Journey CLI/);
    assert.match(await readFile(join(repository, '.journey/AGENTS.md'), 'utf8'), /BEFORE editing/);
    succeeds(await f.run(git, ['-C', repository, 'check-ignore', '.journey/config.json']));
});
