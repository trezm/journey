import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = process.env.AVC_TEST_URL ?? 'http://127.0.0.1:4173';
const temp = mkdtempSync(join(tmpdir(), 'journey-cli-')), source = join(temp, 'source'), cli = resolve('public/journey.mjs');
const env = { ...process.env, JOURNEY_CONFIG_HOME: join(temp, 'config') }; let cookie;
async function request(path, body, expected = 200, bearer) {
    const r = await fetch(root + path, { method: body ? 'POST' : 'GET', headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : { Cookie: cookie ?? '' }), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    const d = await r.json(); assert.equal(r.status, expected, JSON.stringify(d)); return d.result ?? d;
}
function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function run(dir, ...args) {
    const proc = spawn(process.execPath, [cli, ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', error = '';
    proc.stdout.on('data', x => out += x); proc.stderr.on('data', x => error += x);
    const code = await new Promise(r => proc.on('close', r)); assert.equal(code, 0, error + out); return JSON.parse(out);
}
const children = [];
try {
    await request('/api/auth', { action: 'register', username: 'test-' + crypto.randomUUID().slice(0, 24), email: 'cli-' + crypto.randomUUID() + '@example.com', password: 'CLI-test-password-2026' });
    const { project } = await request('/api/avc', { action: 'create_project', name: 'Imported CLI repository', empty: true });
    const connection = await request('/api/connect', { project }); const connectionPath = join(temp, 'download.json'); writeFileSync(connectionPath, JSON.stringify(connection));
    const downloadable = await fetch(root + '/journey.mjs'); assert.equal(downloadable.status, 200); assert((await downloadable.text()).includes('importRepo'));
    mkdirSync(source); git(source, ['init', '-b', 'main']); git(source, ['config', 'user.email', 'cli@example.com']); git(source, ['config', 'user.name', 'CLI Test']);
    writeFileSync(join(source, 'one.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
    writeFileSync(join(source, 'binary.dat'), Buffer.from([0, 1, 255, 12])); writeFileSync(join(source, 'executable.sh'), '#!/bin/sh\necho ok\n'); chmodSync(join(source, 'executable.sh'), 0o755);
    symlinkSync('one.txt', join(source, 'link')); mkdirSync(join(source, 'oid')); writeFileSync(join(source, 'oid/file name.txt'), 'directory called oid\n');
    writeFileSync(join(source, 'large.txt'), 'x'.repeat(600000));
    mkdirSync(join(source, 'batch')); for (let i=0; i<140; i++) writeFileSync(join(source, 'batch', 'file-'+i+'.txt'), 'batch file '+i+'\n');
    writeFileSync(join(source, 'AGENTS.md'), '# Existing instructions\nKeep this intact.\n');
    git(source, ['add', '.']); git(source, ['commit', '-m', 'Original commit']); const initial = git(source, ['rev-parse', 'HEAD']);
    git(source, ['tag', '-a', 'v1', '-m', 'Original annotated tag']); const tag = git(source, ['rev-parse', 'v1']); git(source, ['checkout', '-b', 'feature']);
    writeFileSync(join(source, 'feature.txt'), 'already committed\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'Feature commit']); const head = git(source, ['rev-parse', 'HEAD']);
    await run(temp, 'connect', connectionPath); assert.equal(statSync(join(env.JOURNEY_CONFIG_HOME, project + '.json')).mode & 0o777, 0o600);
    const imported = await run(temp, 'import', source); assert.equal(imported.head, head); assert.equal(git(source, ['status', '--porcelain']), '');
    assert.equal(readFileSync(join(source, 'AGENTS.md'), 'utf8'), '# Existing instructions\nKeep this intact.\n');
    assert(readFileSync(join(source, '.journey/AGENTS.md'), 'utf8').includes('BEFORE editing'));
    const clone = join(temp, 'clone'); await run(source, 'clone', clone);
    assert.equal(git(clone, ['rev-parse', 'HEAD']), head); assert.equal(git(clone, ['rev-parse', 'v1']), tag); assert.equal(git(clone, ['rev-parse', 'origin/feature']), head); assert.equal(git(clone, ['rev-parse', 'origin/imported/main']), initial); assert.equal(git(clone, ['cat-file', '-t', initial]), 'commit');
    assert.deepEqual(readFileSync(join(clone, 'binary.dat')), Buffer.from([0, 1, 255, 12])); assert.equal(statSync(join(clone, 'executable.sh')).mode & 0o111, 0o111); git(clone, ['fsck', '--no-dangling']);
    const a = await run(source, 'start', 'Change early line', join(temp, 'agent-a'));
    const b = await run(source, 'start', 'Change late line', join(temp, 'agent-b')); children.push(a.directory, b.directory);
    const aConfig = JSON.parse(readFileSync(join(a.directory, '.journey/config.json'), 'utf8')), aConnection = JSON.parse(readFileSync(aConfig.connection, 'utf8'));
    assert.notEqual(aConnection.token, connection.token);
    const forbidden = await fetch(root + '/api/import?project=' + project + '&op=start', { method: 'POST', headers: { Authorization: 'Bearer ' + aConnection.token } }); assert.equal(forbidden.status, 403);
    await request('/api/avc', { action: 'delegate_agent', project, name: 'Forbidden worker', requestId: crypto.randomUUID() }, 403, aConnection.token);
    const ca = await run(a.directory, 'changeset', 'Edit early region'), cb = await run(b.directory, 'changeset', 'Edit late region');
    await run(a.directory, 'lock', ca.changeset, 'one.txt', '1', '2'); await run(b.directory, 'lock', cb.changeset, 'one.txt', '5', '6');
    writeFileSync(join(a.directory, 'one.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\n'); writeFileSync(join(b.directory, 'one.txt'), 'one\ntwo\nthree\nfour\nFIVE\nsix\n');
    const pa = await run(a.directory, 'publish', ca.changeset, 'Uppercase early line'), pb = await run(b.directory, 'publish', cb.changeset, 'Uppercase late line');
    assert.equal(git(a.directory, ['rev-parse', 'HEAD']), pa.revision); assert.equal(git(b.directory, ['rev-parse', 'HEAD']), pb.revision);
    assert.equal(git(a.directory, ['status', '--porcelain']), ''); assert.deepEqual(readFileSync(join(a.directory, 'binary.dat')), Buffer.from([0, 1, 255, 12]));
    assert.equal(git(a.directory, ['ls-tree', 'HEAD', 'executable.sh']).split(' ')[0], '100755'); assert.equal(git(a.directory, ['ls-tree', 'HEAD', 'link']).split(' ')[0], '120000');
    await run(a.directory, 'run', 'Verify captured command', '--', process.execPath, '-e', 'console.log("check passed"); console.error("stderr captured")');
    const recorded = (await run(a.directory, 'inbox')).events.find(e => e.type === 'recording.recorded'); assert(recorded.data.output.includes('stderr captured'));
    const manifest = join(a.directory, '.journey/breaking.json'); writeFileSync(manifest, '[]'); await run(a.directory, 'manifest', manifest); await run(a.directory, 'submit');
    const s = (await request('/api/avc?project=' + project)).state;
    await request('/api/avc', { action: 'review', project, journey: a.journey, kind: 'approve', body: 'Reviewed imported workflow', revision: pa.revision, requestId: crypto.randomUUID() });
    await run(a.directory, 'integrate');
    const inbox = await run(b.directory, 'inbox'); const event = inbox.events.find(e => e.type === 'journey.integrated'); assert(event);
    const dispositions = join(b.directory, '.journey/dispositions.json'); writeFileSync(dispositions, JSON.stringify({ [event.id]: 'unaffected' }));
    await run(b.directory, 'reconcile', dispositions); assert.equal(readFileSync(join(b.directory, 'one.txt'), 'utf8'), 'ONE\ntwo\nthree\nfour\nFIVE\nsix\n');
    await run(b.directory, 'abandon');
    // The original imported refs and objects are still cloneable after integration.
    const final = join(temp, 'final'); await run(source, 'clone', final); git(final, ['fsck', '--no-dangling']); assert.equal(git(final, ['rev-parse', 'v1']), tag); assert.equal(git(final, ['cat-file', '-t', initial]), 'commit');
    assert.equal(readFileSync(join(final, 'large.txt'), 'utf8').length, 600000); assert.equal(git(final, ['ls-tree', 'HEAD', 'executable.sh']).split(' ')[0], '100755'); assert.deepEqual(readFileSync(join(final, 'binary.dat')), Buffer.from([0, 1, 255, 12]));
    console.log('CLI smoke passed: connection download, complete Git import, branches/tags/binary/modes, preserved AGENTS.md, delegated workers, isolated parallel edits, captured checks, review, integration and reconciliation.');
} finally {
    for (const directory of children) { try { const pid = Number(readFileSync(join(directory, '.journey/watcher.pid'), 'utf8')); process.kill(pid, 'SIGTERM'); } catch {} }
}
