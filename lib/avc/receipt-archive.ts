import { type State, insist } from './core.ts';

// Keep routine requests small. Only committed receipts are moved, before the
// caller can mutate state; losing the subsequent state CAS cannot publish a
// result for an operation that never committed.
export const INLINE_RECEIPT_BYTES = 256_000;
export const ARCHIVE_BATCH_PARTS = 64;
const PART_CHARACTERS = 200_000;

export async function archiveCommittedReceipts(db: D1Database, state: State): Promise<boolean> {
    const entries = Object.entries(state.receipts).map(([key, value]) => ({ key, json: JSON.stringify(value) }));
    if (entries.reduce((size, entry) => size + Buffer.byteLength(entry.json, 'utf8'), 0) < INLINE_RECEIPT_BYTES) return false;
    entries.sort((a, b) => b.json.length - a.json.length);
    const selected: string[] = [], statements: D1PreparedStatement[] = [];
    for (const { key, json } of entries) {
        const parts = Math.ceil(json.length / PART_CHARACTERS);
        if (statements.length + parts > ARCHIVE_BATCH_PARTS) continue;
        for (let part = 0; part < parts; part++) {
            // JSON-encode each segment so splitting a UTF-16 surrogate pair does
            // not lose a character when the database encodes strings as UTF-8.
            const payload = JSON.stringify(json.slice(part * PART_CHARACTERS, (part + 1) * PART_CHARACTERS));
            statements.push(db.prepare(`INSERT INTO receipt_archive(project,receipt_key,part,parts,payload) VALUES(?,?,?,?,?)
                ON CONFLICT(project,receipt_key,part) DO UPDATE SET payload=
                CASE WHEN receipt_archive.payload=excluded.payload AND receipt_archive.parts=excluded.parts
                THEN receipt_archive.payload ELSE NULL END`).bind(state.id, key, part, parts, payload));
        }
        selected.push(key);
    }
    if (!statements.length) return false;
    // D1 batches are atomic. A conflicting existing value violates NOT NULL,
    // failing closed rather than overwriting an immutable historical result.
    const results = await db.batch(statements);
    insist(results.length === statements.length && results.every(result => result.success), 'receipt_archive_failed', 'Repository retry history could not be saved. Retry the request.', 503);
    for (const key of selected) delete state.receipts[key];
    state.receiptsArchived = true;
    return true;
}

export async function readReceipt(db: D1Database, state: State, key: string): Promise<unknown> {
    if (Object.hasOwn(state.receipts, key)) return state.receipts[key];
    if (!state.receiptsArchived) return undefined;
    const { results } = await db.prepare('SELECT part,parts,payload FROM receipt_archive WHERE project=? AND receipt_key=? ORDER BY part').bind(state.id, key).all<{ part: number; parts: number; payload: string }>();
    if (!results.length) return undefined;
    insist(results.every((row, index) => row.part === index && row.parts === results.length), 'invalid_receipt', 'Stored repository retry history is incomplete.', 500);
    try { return JSON.parse(results.map(row => JSON.parse(row.payload)).join('')); }
    catch { insist(false, 'invalid_receipt', 'Stored repository retry history is malformed.', 500); }
}
