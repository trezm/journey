import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitLabTransport, gitlabTarget } from '../lib/avc/gitlab-transport.ts';
import { object, concatenate, parseTree } from '../lib/avc/git.ts';

function fixture(t) {
    const path = mkdtempSync(join(tmpdir(), 'journey-gitlab-')); t.after(() => rmSync(path, { recursive: true, force: true }));
    execFileSync('git', ['init', '--bare', '--quiet', path]);
    const git = (args, input) => execFileSync('git', ['--git-dir=' + path, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'] });
    git(['config', 'uploadpack.allowFilter', 'true']); git(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    const send = async (url, init = {}) => {
        const parsed = new URL(url); assert.equal(parsed.hostname, 'gitlab.com'); assert.equal(init.redirect, 'manual');
        if (parsed.pathname.endsWith('/info/refs')) return new Response(execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', path]));
        if (parsed.pathname.endsWith('/git-upload-pack') || parsed.pathname.endsWith('/git-receive-pack')) {
            assert.equal(init.headers.Authorization, 'Basic ' + btoa('oauth2:test-token'));
            return new Response(execFileSync('git', [parsed.pathname.endsWith('/git-upload-pack') ? 'upload-pack' : 'receive-pack', '--stateless-rpc', path], { input: init.body, stdio: ['pipe', 'pipe', 'pipe'] }));
        }
        assert.equal(init.headers.Authorization, 'Bearer test-token');
        const branch = parsed.pathname.split('/repository/branches/')[1];
        if (branch) {
            try { return Response.json({ commit: { id: git(['rev-parse', '--verify', 'refs/heads/' + decodeURIComponent(branch)]).toString().trim() } }); }
            catch { return new Response('', { status: 404 }); }
        }
        const blob = parsed.pathname.match(/\/repository\/blobs\/([a-f0-9]{40})\/raw$/)?.[1];
        if (blob) return new Response(git(['cat-file', 'blob', blob]));
        const commit = parsed.pathname.match(/\/repository\/commits\/([a-f0-9]{40})$/)?.[1];
        if (commit) { try { git(['cat-file', 'commit', commit]); return Response.json({ id: commit }); } catch { return new Response('', { status: 404 }); } }
        return Response.json({ id: 1, namespace: { kind: 'user' }, permissions: { project_access: { access_level: 40 } } });
    };
    return { git, transport: new GitLabTransport('owner/repo', 'test-token', send, undefined, 'journey-objects/test/run') };
}
test('GitLab rejects credential URLs and unsupported provider origins', () => {
    assert.equal(gitlabTarget('https://gitlab.com/alice/repo.git'), 'alice/repo');
    for (const url of ['https://token@gitlab.com/alice/repo', 'https://gitlab.com.evil/alice/repo', 'https://gitlab.com/alice/repo?x=1', 'https://gitlab.com/../repo', 'http://gitlab.com/alice/repo']) assert.throws(() => gitlabTarget(url));
});
test('native GitLab protocol round-trip preserves binary blobs, nested trees and exact signed commits', async t => {
    const { git, transport } = fixture(t); await transport.authorizeRepository(true);
    const bytes = Buffer.from([0, 1, 250, 255]), blob = await object('blob', bytes);
    await transport.write(blob.oid, 'blob', bytes);
    assert.deepEqual(await transport.read(blob.oid, 'blob'), new Uint8Array(bytes));
    const childBody = concatenate(Buffer.from('100755 script\0'), Buffer.from(blob.oid, 'hex')), child = await object('tree', childBody);
    await transport.write(child.oid, 'tree', childBody);
    const rootBody = concatenate(Buffer.from('40000 nested\0'), Buffer.from(child.oid, 'hex')), root = await object('tree', rootBody);
    await transport.write(root.oid, 'tree', rootBody);
    const commitBody = Buffer.from(`tree ${root.oid}\nauthor A <a@b> 1 -0700\ncommitter B <b@c> 2 +0530\ngpgsig -----BEGIN PGP SIGNATURE-----\n signed bytes\n -----END PGP SIGNATURE-----\n\nmessage\n`), commit = await object('commit', commitBody);
    assert.equal(await transport.has(commit.oid, 'commit'), false);
    await transport.push('refs/heads/main', null, commit.oid, commitBody);
    assert.equal(await transport.head('main'), commit.oid); assert.equal(await transport.has(commit.oid, 'commit'), true);
    assert.deepEqual(await transport.read(commit.oid, 'commit'), commitBody);
    assert.deepEqual(await transport.read(root.oid, 'tree'), Buffer.from(rootBody));
    assert.deepEqual(await transport.read(child.oid, 'tree'), Buffer.from(childBody));
    assert.equal(parseTree(await transport.read(child.oid, 'tree'))[0].mode, '100755');
    await assert.rejects(transport.push('refs/heads/main', null, commit.oid), error => error.code === 'github_push');
    assert.equal(await transport.head('main'), commit.oid); git(['fsck', '--strict', '--no-reflogs']);
});
test('GitLab checks writable personal repository, denies redirects, and never forwards secrets', async () => {
    const denied = new GitLabTransport('owner/repo', 'private-token', async () => Response.json({ id: 1, namespace: { kind: 'group' }, permissions: { project_access: { access_level: 50 } } }));
    await assert.rejects(denied.authorizeRepository(), error => error.status === 403);
    let requests = 0;
    const moved = new GitLabTransport('owner/repo', 'private-token', async (url, init) => { requests++; assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://evil.test' } }); });
    await assert.rejects(moved.authorizeRepository(), error => !error.message.includes('private-token')); assert.equal(requests, 1);
});
