import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { archiveCommittedReceipts, readReceipt, ARCHIVE_BATCH_PARTS } from '../lib/avc/receipt-archive.ts';
import { encodeState, decodeState, MAX_STORED_STATE_BYTES } from '../lib/avc/state-codec.ts';
import { publicState } from '../lib/avc/core.ts';

function fixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,owner TEXT,name TEXT,visibility TEXT,version INTEGER,state TEXT); CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,email TEXT,password TEXT); CREATE TABLE sessions(digest TEXT PRIMARY KEY,user TEXT,expires INTEGER);');
    sqlite.exec(readFileSync(new URL('../drizzle/0006_receipt_archive.sql', import.meta.url), 'utf8'));
    const db = { failBatch: false, failUpdate: false, conflict: null, batches: [], prepare(sql) { return { bind(...args) { return {
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() {
            if (sql.startsWith('UPDATE projects')) {
                if (db.failUpdate) throw Error('state write failed');
                if (db.conflict && db.conflict(args)) { db.conflict = null; return { meta: { changes: 0 } }; }
            }
            return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
        },
    }; } }; }, async batch(statements) {
        db.batches.push(statements.length);
        if (db.failBatch) throw Error('archive unavailable');
        sqlite.exec('BEGIN');
        try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
    const state = { id: 'repo', name: 'Repo', head: 'a'.repeat(40), revisions: {}, journeys: [], leases: [], waiting: [], events: [], sequence: 0, integrationCursor: 0, generation: 0, receipts: {}, requireApproval: true };
    const save = () => sqlite.prepare('INSERT OR REPLACE INTO projects VALUES(?,?,?,?,?,?)').run('repo', 'owner', 'Repo', 'private', 0, encodeState(state));
    const load = () => decodeState(sqlite.prepare('SELECT state FROM projects').get().state);
    return { sqlite, db, state, save, load };
}
function fill(state, count = 100, size = 6000) {
    for (let i = 0; i < count; i++) state.receipts[`actor:${i}`] = { request: `fingerprint-${i}`, result: { locks: [{ token: `historical-${i}`, expires: i }], output: randomBytes(size).toString('base64') } };
}

test('committed receipts migrate in bounded batches and replay exactly across projects and actors', async () => {
    const f = fixture();
    try {
        fill(f.state);
        const receipts = structuredClone(f.state.receipts);
        const history = structuredClone({ events: f.state.events, journeys: f.state.journeys });
        await archiveCommittedReceipts(f.db, f.state);
        assert.equal(f.db.batches[0], ARCHIVE_BATCH_PARTS);
        assert.equal(Object.keys(f.state.receipts).length, 36);
        await archiveCommittedReceipts(f.db, f.state);
        for (const [key, receipt] of Object.entries(receipts)) assert.deepEqual(await readReceipt(f.db, f.state, key), receipt);
        assert.deepEqual({ events: f.state.events, journeys: f.state.journeys }, history);
        assert.equal(await readReceipt(f.db, { ...f.state, id: 'other' }, 'actor:99'), undefined);
        assert.equal(await readReceipt(f.db, f.state, 'other-actor:99'), undefined);
        assert(!JSON.stringify(publicState(f.state, 'owner')).includes('receiptsArchived'));
    } finally { f.sqlite.close(); }
});

test('chunking preserves Unicode and big receipts; missing chunks and conflicting history fail closed', async () => {
    const f = fixture();
    try {
        const key = 'actor:large';
        f.state.receipts[key] = { request: 'hash', result: '💙'.repeat(400000) };
        const original = structuredClone(f.state);
        await archiveCommittedReceipts(f.db, f.state);
        assert.deepEqual(await readReceipt(f.db, f.state, key), original.receipts[key]);
        // A concurrent migration of the same committed receipt is safe.
        await archiveCommittedReceipts(f.db, structuredClone(original));
        const changed = structuredClone(original); changed.receipts[key].request = 'different';
        await assert.rejects(archiveCommittedReceipts(f.db, changed), /NOT NULL/);
        assert.deepEqual(changed.receipts, { [key]: changed.receipts[key] });
        assert.deepEqual(await readReceipt(f.db, f.state, key), original.receipts[key]);
        f.sqlite.prepare('DELETE FROM receipt_archive WHERE part=1').run();
        await assert.rejects(readReceipt(f.db, f.state, key), error => error.code === 'invalid_receipt');
    } finally { f.sqlite.close(); }
});

test('archive failures leave in-memory and persisted history intact', async () => {
    const f = fixture();
    try {
        fill(f.state); const original = structuredClone(f.state); f.save(); f.db.failBatch = true;
        await assert.rejects(archiveCommittedReceipts(f.db, f.state), /archive unavailable/);
        assert.deepEqual(f.state, original); assert.deepEqual(f.load(), original);
    } finally { f.sqlite.close(); }
});

test('storage migrates before capacity checks and never archives uncommitted mutation results', async t => {
    globalThis.__receiptArchiveEnv = { BUCKET: {} };
    const checkout = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const hooks = registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=globalThis.__receiptArchiveEnv;', shortCircuit: true };
        if (specifier.startsWith('@/')) return next(pathToFileURL(checkout + '/' + specifier.slice(2) + '.ts').href, context);
        return next(specifier, context);
    } });
    t.after(() => { hooks.deregister(); delete globalThis.__receiptArchiveEnv; });
    const { mutate } = await import('../lib/avc/storage.ts');
    const { digest } = await import('../lib/avc/auth.ts');
    const { POST } = await import('../app/api/avc/route.ts');
    await t.test('an incoming result crossing the old compressed limit succeeds without dropping existing data', async () => {
        const f = fixture(); globalThis.__receiptArchiveEnv.DB = f.db;
        try {
            fill(f.state, 200, 5000); f.save();
            const original = structuredClone(f.state.receipts);
            const result = randomBytes(400000).toString('base64');
            assert.throws(() => encodeState({ ...f.state, receipts: { ...original, incoming: { request: 'new', result } } }), error => error.code === 'project_capacity');
            await mutate('repo', state => { state.receipts.incoming = { request: 'new', result }; return result; });
            const stored = f.load();
            assert(Buffer.byteLength(encodeState(stored)) < MAX_STORED_STATE_BYTES);
            for (const [key, receipt] of Object.entries(original)) assert.deepEqual(await readReceipt(f.db, stored, key), receipt);
            assert.deepEqual(stored.receipts.incoming, { request: 'new', result });
            assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM receipt_archive WHERE receipt_key='incoming'").get().n, 0);
        } finally { f.sqlite.close(); }
    });
    await t.test('lost CAS and state-write failure keep speculative receipts out of archive', async () => {
        const f = fixture(); globalThis.__receiptArchiveEnv.DB = f.db;
        try {
            fill(f.state); f.save(); let attempts = 0;
            f.db.conflict = args => { if (!decodeState(args[0]).receipts.incoming) return false; f.sqlite.prepare('UPDATE projects SET version=version+1').run(); return true; };
            await mutate('repo', state => { attempts++; state.receipts.incoming = { request: 'new', result: attempts }; });
            assert.equal(attempts, 2); assert.equal(f.load().receipts.incoming.result, 2);
            assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM receipt_archive WHERE receipt_key='incoming'").get().n, 0);
            f.db.failUpdate = true;
            await assert.rejects(mutate('repo', state => { state.receipts.failed = { request: 'failed', result: 3 }; }), /state write failed/);
            assert.equal(f.load().receipts.failed, undefined);
            assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM receipt_archive WHERE receipt_key='failed'").get().n, 0);
        } finally { f.sqlite.close(); }
    });
    await t.test('compaction makes durable progress even when the following action is too large', async () => {
        const f = fixture(); globalThis.__receiptArchiveEnv.DB = f.db;
        try {
            fill(f.state, 200, 5000); f.save();
            for (const remaining of [136, 72, 8]) {
                await assert.rejects(mutate('repo', state => { state.name = 'x'.repeat(12_000_000); }), error => error.code === 'project_capacity');
                assert.equal(Object.keys(f.load().receipts).length, remaining);
                assert.equal(f.load().name, 'Repo');
            }
            for (const [key, receipt] of Object.entries(f.state.receipts)) assert.deepEqual(await readReceipt(f.db, f.load(), key), receipt);
        } finally { f.sqlite.close(); }
    });
    await t.test('HTTP retry returns original result and rejects a changed payload after archival', async () => {
        const f = fixture(); globalThis.__receiptArchiveEnv.DB = f.db;
        try {
            const body = JSON.stringify({ action: 'create_journey', project: 'repo', requestId: 'original', title: 'Original' });
            fill(f.state); f.state.receipts['owner:original'] = { request: await digest(body), result: { journey: 'already-created', data: 'x'.repeat(300000) } };
            f.save(); f.sqlite.prepare('INSERT INTO users VALUES(?,?,?,?)').run('owner', 'Owner', 'owner@example.test', 'unused');
            f.sqlite.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await digest('session'), 'owner', Date.now() + 60000);
            const post = text => POST(new Request('http://localhost/api/avc', { method: 'POST', headers: { Cookie: 'avc_session=session', 'Content-Type': 'application/json' }, body: text }));
            const response = await post(body); assert.equal(response.status, 200); assert.deepEqual((await response.json()).result, f.state.receipts['owner:original'].result);
            assert.equal(f.load().journeys.length, 0); assert.equal(f.load().receipts['owner:original'], undefined);
            const conflict = await post(body.replace('Original', 'Changed')); assert.equal((await conflict.json()).code, 'idempotency_conflict');
            const again = await post(body); assert.equal(again.status, 200); assert.deepEqual((await again.json()).result, f.state.receipts['owner:original'].result);
        } finally { f.sqlite.close(); }
    });
});
