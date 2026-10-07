import { inflateSync, deflateSync } from 'node:zlib';
import { insist, type Files } from './core.ts';
const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export type Entry = { mode: string; oid: string };
export type Entries = Record<string, Entry>;
export type SourceFile = { kind: 'text'; content: string } | { kind: 'binary' | 'large' | 'symlink' | 'submodule' };
export type SourceEntry = Entry & { name: string };
export function concatenate(...chunks: Uint8Array[]) { const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let i = 0; for (const c of chunks) { out.set(c, i); i += c.length; } return out; }
export async function object(type: string, body: Uint8Array) { const raw = concatenate(utf8.encode(`${type} ${body.length}\0`), body); const oid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', raw))).map(b => b.toString(16).padStart(2, '0')).join(''); return { oid, raw }; }
export function validPath(path: string) { return path.length <= 1000 && !/[\x00-\x1f\\]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git'); }
export function parseTree(body: Uint8Array): { name: string; mode: string; oid: string }[] {
    const entries = []; let offset = 0;
    while (offset < body.length) {
        const space = body.indexOf(32, offset), nul = body.indexOf(0, space + 1);
        insist(space > offset && nul > space && nul + 21 <= body.length, 'invalid_tree', 'Malformed Git tree.', 400);
        const mode = decoder.decode(body.subarray(offset, space)), name = decoder.decode(body.subarray(space + 1, nul));
        insist(['40000', '100644', '100755', '120000', '160000'].includes(mode) && validPath(name) && !name.includes('/'), 'invalid_tree', 'Unsupported Git tree entry.', 400);
        entries.push({ name, mode, oid: Buffer.from(body.subarray(nul + 1, nul + 21)).toString('hex') }); offset = nul + 21;
    }
    insist(new Set(entries.map(e => e.name)).size === entries.length, 'invalid_tree', 'Duplicate tree entry.', 400);
    return entries;
}
export function decodeObject(compressed: Uint8Array) {
    const raw = inflateSync(compressed, { maxOutputLength: 20_000_000 }); const nul = raw.indexOf(0);
    const header = raw.subarray(0, nul).toString('utf8'); const match = /^(blob|tree|commit|tag) (\d+)$/.exec(header);
    insist(nul > 0 && match && Number(match[2]) === raw.length - nul - 1, 'invalid_object', 'Malformed Git object.', 400);
    const body = raw.subarray(nul + 1); return { type: match[1], body, raw };
}
export function references(type: string, body: Uint8Array): string[] {
    if (type === 'blob') return [];
    if (type === 'tree') return parseTree(body).filter(e => e.mode !== '160000').map(e => e.oid);
    const header = new TextDecoder().decode(body).split('\n\n')[0];
    const refs = [...header.matchAll(type === 'tag' ? /^object ([a-f0-9]{40})$/gm : /^(?:tree|parent) ([a-f0-9]{40})$/gm)].map(m => m[1]);
    insist(refs.length && (type !== 'commit' || /^tree [a-f0-9]{40}$/m.test(header)), 'invalid_object', 'Git commit/tag has no valid target.', 400);
    return refs;
}
export async function makeCommit(files: Files, parent: string | undefined, message: string, actor: string, at = Date.now(), preserved: Entries = {}, previous?: { entries: Entries; tree: string }) {
    const objects: { oid: string; raw: Uint8Array }[] = [];
    const entries: Entries = Object.assign(Object.create(null), preserved);
    for (const [path, text] of Object.entries(files)) {
        insist(validPath(path), 'invalid_path', 'Use relative file paths without traversal.', 400);
        insist(utf8.encode(text).length <= 500000, 'file_too_large', 'Editable text files must be at most 500 KB.', 413);
        const blob = await object('blob', utf8.encode(text)); objects.push(blob);
        entries[path] = { oid: blob.oid, mode: entries[path]?.mode ?? '100644' };
    }
    type Tree = { [name: string]: Entry | Tree };
    function asTree(source: Entries): Tree {
        const root: Tree = Object.create(null);
        for (const [path, entry] of Object.entries(source)) {
            const parts = path.split('/'); let t = root;
            for (const part of parts.slice(0, -1)) {
                insist(!t[part] || typeof t[part].oid !== 'string', 'path_collision', 'A path is both a file and a directory.', 400);
                t[part] ??= Object.create(null); t = t[part] as Tree;
            }
            const name = parts.at(-1)!;
            insist(!t[name] || typeof t[name].oid === 'string', 'path_collision', 'A path is both a file and a directory.', 400); t[name] = entry;
        }
        return root;
    }
    const knownTrees = new Set<string>();
    async function build(t: Tree, remember = false): Promise<string> {
        const chunks: Uint8Array[] = [];
        const names = Object.keys(t).sort((a, b) => Buffer.compare(Buffer.from(a + (typeof t[a].oid === 'string' ? '' : '/')), Buffer.from(b + (typeof t[b].oid === 'string' ? '' : '/'))));
        for (const name of names) {
            const v = t[name]; const entry = typeof v.oid === 'string' ? v as Entry : { oid: await build(v as Tree, remember), mode: '40000' };
            chunks.push(concatenate(utf8.encode(`${entry.mode} ${name}\0`), Buffer.from(entry.oid, 'hex')));
        }
        const tree = await object('tree', concatenate(...chunks));
        if (remember) knownTrees.add(tree.oid);
        else if (!knownTrees.has(tree.oid)) objects.push(tree);
        return tree.oid;
    }
    if (previous) {
        // Imported trees can contain empty directories or unusual ordering.
        // Reconstructed hashes are known to exist only if the root matches.
        const tree = await build(asTree(previous.entries), true);
        if (tree !== previous.tree) knownTrees.clear();
    }
    const tree = await build(asTree(entries)), name = actor.replace(/[\n\r<>]/g, '').slice(0, 80) || 'Agent';
    const identity = `${name} <agent@journey.local> ${Math.floor(at / 1000)} +0000`;
    const commit = await object('commit', utf8.encode(`tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${identity}\ncommitter ${identity}\n\n${message.replace(/\r/g, '')}\n`));
    objects.push(commit); return { oid: commit.oid, objects, files, entries, parent, message, actor, at };
}
export class GitStore {
    private bucket: R2Bucket; private project: string;
    constructor(bucket: R2Bucket, project: string) { this.bucket = bucket; this.project = project; }
    key(oid: string) { insist(/^[a-f0-9]{40}$/.test(oid), 'invalid_revision', 'Invalid Git object hash.', 400); return `${this.project}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`; }
    async read(oid: string) { const stored = await this.bucket.get(this.key(oid)); insist(stored, 'object_missing', `Git object ${oid} is missing.`, 404); return decodeObject(new Uint8Array(await stored.arrayBuffer())); }
    // Browsing follows only the requested path. Never materialize the repository snapshot.
    private async sourceEntry(oid: string, path: string): Promise<Entry> {
        insist(!path || validPath(path), 'invalid_path', 'Use relative file paths without traversal.', 400);
        const parts = path ? path.split('/') : [];
        insist(parts.length <= 40, 'tree_capacity', 'Repository path exceeds browsing limits.', 413);
        const commit = await this.read(oid);
        insist(commit.type === 'commit', 'invalid_revision', 'Expected a Git commit.', 400);
        const tree = /^tree ([a-f0-9]{40})$/m.exec(new TextDecoder().decode(commit.body))?.[1];
        insist(tree, 'invalid_commit', 'Commit has no tree.', 400);
        let entry: Entry = { mode: '40000', oid: tree };
        for (const part of parts) {
            insist(entry.mode === '40000', 'path_not_found', 'Path is not a directory.', 404);
            const data = await this.read(entry.oid);
            insist(data.type === 'tree', 'invalid_tree', 'Expected a tree object.', 400);
            const next = parseTree(data.body).find(candidate => candidate.name === part);
            insist(next, 'path_not_found', 'Path does not exist in this revision.', 404);
            entry = next;
        }
        return entry;
    }
    async sourceTree(oid: string, path = ''): Promise<SourceEntry[]> {
        const entry = await this.sourceEntry(oid, path);
        insist(entry.mode === '40000', 'not_directory', 'Expected a directory.', 400);
        const data = await this.read(entry.oid);
        insist(data.type === 'tree', 'invalid_tree', 'Expected a tree object.', 400);
        return parseTree(data.body).sort((a, b) => Number(b.mode === '40000') - Number(a.mode === '40000') || a.name.localeCompare(b.name));
    }
    async sourceFile(oid: string, path: string): Promise<SourceFile> {
        insist(path, 'invalid_path', 'A file path is required.', 400);
        const entry = await this.sourceEntry(oid, path);
        if (entry.mode === '120000') return { kind: 'symlink' };
        if (entry.mode === '160000') return { kind: 'submodule' };
        insist(['100644', '100755'].includes(entry.mode), 'not_file', 'Expected a file.', 400);
        const blob = await this.read(entry.oid);
        insist(blob.type === 'blob', 'invalid_blob', 'Expected a blob.', 400);
        if (blob.body.length > 500000) return { kind: 'large' };
        if (blob.body.includes(0)) return { kind: 'binary' };
        try { return { kind: 'text', content: decoder.decode(blob.body) }; }
        catch { return { kind: 'binary' }; }
    }
    async entries(oid: string): Promise<Entries> {
        const cached = await this.bucket.get(`${this.project}/trees/${oid}`); if (cached) return JSON.parse(await cached.text());
        const commit = await this.read(oid); insist(commit.type === 'commit', 'invalid_revision', 'Expected a Git commit.', 400);
        const tree = /^tree ([a-f0-9]{40})$/m.exec(new TextDecoder().decode(commit.body))?.[1]; insist(tree, 'invalid_commit', 'Commit has no tree.', 400);
        const result: Entries = Object.create(null); let nodes = 0;
        const visit = async (hash: string, prefix: string, depth: number) => {
            insist(depth <= 40 && ++nodes <= 50000, 'tree_capacity', 'Repository tree exceeds import limits.', 413);
            const data = await this.read(hash); insist(data.type === 'tree', 'invalid_tree', 'Expected a tree object.', 400);
            for (const entry of parseTree(data.body)) {
                const path = prefix + entry.name;
                if (entry.mode === '40000') await visit(entry.oid, path + '/', depth + 1); else result[path] = { oid: entry.oid, mode: entry.mode };
            }
        };
        await visit(tree, '', 0); await this.bucket.put(`${this.project}/trees/${oid}`, JSON.stringify(result)); return result;
    }
    async files(oid: string): Promise<Files> {
        this.key(oid); const snapshot = await this.bucket.get(`${this.project}/snapshots/${oid}`); if (snapshot) return JSON.parse(await snapshot.text());
        const entries = await this.entries(oid), files: Files = Object.create(null); let bytes = 0;
        // Non-text, symlink, submodule and large files remain in Git and are preserved by save().
        for (const [path, entry] of Object.entries(entries)) {
            if (!['100644', '100755'].includes(entry.mode)) continue;
            const blob = await this.read(entry.oid); insist(blob.type === 'blob', 'invalid_blob', 'Expected a blob.', 400);
            if (blob.body.length > 500000 || blob.body.includes(0)) continue;
            let text; try { text = decoder.decode(blob.body); } catch { continue; }
            if (bytes + blob.body.length > 12_000_000 || Object.keys(files).length >= 4000) continue;
            files[path] = text; bytes += blob.body.length;
        }
        await this.bucket.put(`${this.project}/snapshots/${oid}`, JSON.stringify(files)); return files;
    }
    async save(files: Files, parent: string | undefined, message: string, actor: string, preserveFrom = parent) {
        insist(Object.keys(files).length <= 4000 && Object.values(files).reduce((n, text) => n + utf8.encode(text).length, 0) <= 12_000_000, 'text_capacity', 'Editable snapshot exceeds 4,000 files or 12 MB. Untouched non-editable Git entries are preserved.', 413);
        let preserved: Entries = Object.create(null), previous: { entries: Entries; tree: string } | undefined;
        let changed = files;
        // Reconciliation retains the journey's commit ancestry, but inherits
        // modes and non-editable entries from the latest canonical tree.
        if (preserveFrom) {
            const entries = await this.entries(preserveFrom), commit = await this.read(preserveFrom);
            insist(commit.type === 'commit', 'invalid_revision', 'Expected a Git commit.', 400);
            const tree = /^tree ([a-f0-9]{40})$/m.exec(new TextDecoder().decode(commit.body))?.[1];
            insist(tree, 'invalid_commit', 'Commit has no tree.', 400);
            previous = { entries, tree }; preserved = Object.assign(Object.create(null), entries);
            const before = await this.files(preserveFrom);
            for (const path of Object.keys(before)) if (!(path in files)) delete preserved[path];
            for (const path of Object.keys(files)) insist(!preserved[path] || path in before, 'unsupported_edit', `${path} is a binary, symlink, submodule or file outside the text editing limits. It is preserved but cannot be edited through this API.`, 400);
            changed = Object.fromEntries(Object.entries(files).filter(([path, text]) => before[path] !== text));
        }
        // Git objects are immutable. Reuse unchanged blobs and trees so a small
        // integration does not rewrite the entire repository before publishing.
        const c = await makeCommit(changed, parent, message, actor, Date.now(), preserved, previous);
        const objects = [...new Map(c.objects.map(obj => [obj.oid, obj])).values()];
        for (let start = 0; start < objects.length; start += 4) {
            // Settle each batch before throwing, leaving no request I/O running.
            const writes = await Promise.allSettled(objects.slice(start, start + 4).map(obj => this.bucket.put(this.key(obj.oid), deflateSync(obj.raw))));
            for (const write of writes) if (write.status === 'rejected') throw write.reason;
        }
        await this.bucket.put(`${this.project}/snapshots/${c.oid}`, JSON.stringify(files)); await this.bucket.put(`${this.project}/trees/${c.oid}`, JSON.stringify(c.entries));
        return { oid: c.oid, meta: { parent, message, actor, at: c.at } };
    }
    async gitObject(path: string) { return this.bucket.get(`${this.project}/${path}`); }
}
