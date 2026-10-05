import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GitStore } from '../lib/avc/git.ts';

class MemoryBucket {
    data = new Map();
    async put(key, value) { this.data.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)); }
    async get(key) { const bytes = this.data.get(key); return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => new TextDecoder().decode(bytes), json: async () => JSON.parse(new TextDecoder().decode(bytes)), body: bytes } : null; }
}
test('repository routes isolate two accounts, safely expose public main, and revoke future reads when private', async t => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,email TEXT,password TEXT); CREATE TABLE sessions(digest TEXT PRIMARY KEY,user TEXT,expires INTEGER); CREATE TABLE projects(id TEXT PRIMARY KEY,owner TEXT,name TEXT,visibility TEXT NOT NULL DEFAULT 'private',version INTEGER NOT NULL DEFAULT 0,state TEXT); CREATE TABLE agents(digest TEXT PRIMARY KEY,project TEXT,name TEXT,role TEXT,created INTEGER);`);
    const db = { prepare(sql) { return { bind(...args) { const statement = sqlite.prepare(sql); return { async first() { return statement.get(...args) ?? null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; } }; } }; } };
    const bucket = new MemoryBucket(); globalThis.__visibilityTestEnv = { DB: db, BUCKET: bucket, AVC_AUTH_MODE: 'password' };
    const checkout = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const hooks = registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__visibilityTestEnv;', shortCircuit: true };
        if (specifier.startsWith('@/')) return next(pathToFileURL(checkout + '/' + specifier.slice(2) + '.ts').href, context);
        return next(specifier, context);
    } });
    t.after(() => { hooks.deregister(); sqlite.close(); delete globalThis.__visibilityTestEnv; });
    const { digest } = await import('../lib/avc/auth.ts');
    const avc = await import('../app/api/avc/route.ts'), gitRoute = await import('../app/api/git/[project]/[...path]/route.ts');
    const connect = await import('../app/api/connect/route.ts'), importing = await import('../app/api/import/route.ts'), sync = await import('../app/api/sync/route.ts');
    for (const id of ['alice', 'bob']) {
        sqlite.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, id, `${id}-private@example.test`, 'unused');
        sqlite.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await digest(id + '-session'), id, Date.now() + 60000);
    }
    sqlite.prepare('INSERT INTO agents VALUES(?,?,?,?,?)').run(await digest('repo-agent'), 'repo', 'Worker', 'worker', Date.now());
    sqlite.prepare('INSERT INTO agents VALUES(?,?,?,?,?)').run(await digest('other-agent'), 'other', 'Worker', 'worker', Date.now());
    const git = new GitStore(bucket, 'repo'), initial = await git.save({ 'README.md': 'Accepted code' }, undefined, 'Initial accepted revision', 'alice-private@example.test');
    const draft = await git.save({ 'secret.txt': 'Unpublished draft' }, initial.oid, 'Private draft', 'Worker');
    const state = { id: 'repo', name: 'Alice repo', head: initial.oid, revisions: { [initial.oid]: initial.meta, [draft.oid]: draft.meta }, journeys: [{ id: 'secret-journey', title: 'Private work', actor: 'alice', head: draft.oid, status: 'working' }], leases: [], waiting: [], events: [{ id: 1, type: 'recording.recorded', targets: ['secret-journey'], data: { output: 'private command output' } }], receipts: { secret: 'private receipt' }, sync: { remote: 'https://private.example/repo', backupRefs: { secret: draft.oid } }, sequence: 1, integrationCursor: 0, generation: 0, requireApproval: true };
    sqlite.prepare('INSERT INTO projects(id,owner,name,state) VALUES(?,?,?,?)').run('repo', 'alice', 'Alice repo', JSON.stringify(state));
    const request = (path, who, body, extraHeaders = {}) => new Request('http://localhost' + path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { ...(who ? { Cookie: `avc_session=${who}-session` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders } });
    async function get(who, query = '', expected = 200, extraHeaders = {}) { const response = await avc.GET(request('/api/avc?project=repo' + query, who, undefined, extraHeaders)); const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); return data; }
    async function list(who) { const response = await avc.GET(request('/api/avc', who)); assert.equal(response.status, 200); return response.json(); }
    async function mutation(who, action, data = {}, expected = 200, headers = {}) { const response = await avc.POST(request('/api/avc', who, { action, project: 'repo', requestId: crypto.randomUUID(), ...data }, headers)); const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body; }
    async function gitGet(who, path, expected, headers = {}) { const response = await gitRoute.GET(request('/api/git/repo/' + path, who, undefined, headers), { params: Promise.resolve({ project: 'repo', path: path.split('/') }) }); assert.equal(response.status, expected, await response.clone().text()); assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); return response; }
    const objectPath = oid => `objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    assert.equal((await list('alice')).projects.length, 1);
    for (const who of ['bob', undefined]) { assert.deepEqual((await list(who)).projects, []); await get(who, '', 404); await gitGet(who, 'HEAD', 404); }
    await mutation('bob', 'visibility', { visibility: 'public' }, 403);
    await mutation(undefined, 'visibility', { visibility: 'public' }, 401);
    await mutation(undefined, 'visibility', { visibility: 'public' }, 403, { Authorization: 'Bearer repo-agent' });
    await mutation('alice', 'visibility', { visibility: 'PUBLIC' }, 400);
    await mutation('alice', 'visibility', { visibility: 'public' });
    const draftBlob = (await git.entries(draft.oid))['secret.txt'].oid;
    for (const who of ['bob', undefined]) {
        const discovery = await list(who); assert.equal(discovery.projects[0].visibility, 'public'); assert.equal(discovery.projects[0].permissions.write, false); assert.equal(discovery.projects[0].owner.username, 'alice');
        const publicRead = await get(who), serialized = JSON.stringify({ state: publicRead.state, project: publicRead.project });
        for (const privateValue of ['Private work', 'Private draft', 'secret-journey', 'private command output', 'private receipt', 'private.example', 'private@example.test', draft.oid]) assert(!serialized.includes(privateValue), privateValue);
        assert.equal(publicRead.project.permissions.write, false);
        const files = await get(who, '&revision=' + initial.oid); assert.equal(files.files['README.md'], 'Accepted code');
        await get(who, '&revision=' + draft.oid, 404); await get(who, '&journey=secret-journey', 403); await get(who, '&approvals=1', 403); await get(who, '&live=1', 403);
        const refs = await (await gitGet(who, 'info/refs', 200)).text(); assert.equal(refs, `${initial.oid}\trefs/heads/main\n`);
        await gitGet(who, objectPath(initial.oid), 200); await gitGet(who, objectPath(draft.oid), 404); await gitGet(who, objectPath(draftBlob), 404);
        await mutation(who, 'create_journey', { title: 'Unauthorized' }, who ? 403 : 401);
        await mutation(who, 'create_agent', { name: 'Unauthorized' }, who ? 403 : 401);
        for (const [route, path, body] of [[connect.POST, '/api/connect', { project: 'repo' }], [importing.POST, '/api/import?project=repo&op=start', {}], [sync.POST, '/api/sync', { project: 'repo', action: 'configure' }]]) { const response = await route(request(path, who, body)); assert.equal(response.status, who ? 403 : 401); }
        assert.equal((await sync.GET(request('/api/sync?project=repo', who))).status, who ? 403 : 401);
    }
    for (const authorization of ['Bearer invalid', 'Basic invalid', 'Bearer', 'Other invalid']) { await get('alice', '', 401, { Authorization: authorization }); await gitGet('alice', 'HEAD', 401, { Authorization: authorization }); }
    await get(undefined, '', 404, { Authorization: 'Bearer other-agent' });
    assert.equal((await get('alice')).project.permissions.write, true);
    await gitGet('alice', objectPath(draft.oid), 200);
    await mutation('alice', 'visibility', { visibility: 'private' });
    for (const who of ['bob', undefined]) { await get(who, '', 404); await gitGet(who, objectPath(initial.oid), 404); assert.deepEqual((await list(who)).projects, []); }
    const created = await avc.POST(request('/api/avc', 'bob', { action: 'create_project', name: 'Bob private', empty: true })); assert.equal(created.status, 200); const createdId = (await created.json()).project;
    assert.equal(sqlite.prepare('SELECT visibility FROM projects WHERE id=?').get(createdId).visibility, 'private');
    assert.equal((await list('alice')).projects.some(row => row.id === createdId), false);
    const published = await avc.POST(request('/api/avc', 'bob', { action: 'create_project', name: 'Bob public', empty: true, visibility: 'public' })); assert.equal(published.status, 200); const publishedId = (await published.json()).project;
    assert.equal((await list(undefined)).projects.find(row => row.id === publishedId)?.permissions.write, false);
    assert.equal((await list('bob')).projects.find(row => row.id === publishedId)?.permissions.write, true);
});
