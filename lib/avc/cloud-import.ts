import { deflateSync } from 'node:zlib';
import { insist } from './core.ts';
import { GitStore, decodeObject, object, parseTree, references } from './git.ts';

export type ImportItem = { hash: string; type: 'commit' | 'tree' | 'blob'; expanded?: boolean; depth?: number; path?: string; closure?: TreeClosure; baseline?: string };
type TreeClosure = { version: 1; hash: string; depth: number; path: number };
export type ImportWork = { remote: string | null; todo: ImportItem[]; seen: string[]; importVersion?: 1; importBaselineTree?: string };
export const IMPORT_BATCH = 100;
const MAX_OBJECTS = 50_000;

function capacity(work: ImportWork) {
    insist(work.seen.length <= MAX_OBJECTS && work.todo.length <= MAX_OBJECTS, 'sync_capacity', 'Cloud sync exceeds 50,000 objects; heads are preserved.', 413);
}
function checkContext(item: ImportItem, closure: TreeClosure) {
    insist((item.depth ?? 0) + closure.depth <= 40, 'tree_capacity', 'GitHub tree nesting exceeds Journey’s tree depth limit.', 413);
    const pathLength = (item.path?.length ?? 0) + closure.path - (closure.path === 0 && item.path ? 1 : 0);
    insist(pathLength <= 1000, 'tree_capacity', 'GitHub tree path exceeds Journey’s path limit.', 413);
}
function certificate(value: unknown, hash: string): value is TreeClosure {
    if (!value || typeof value !== 'object') return false;
    const c = value as Partial<TreeClosure>;
    return c.version === 1 && c.hash === hash && Number.isInteger(c.depth) && c.depth! >= 0 && c.depth! <= 40 && Number.isInteger(c.path) && c.path! >= 0 && c.path! <= 1000;
}

/** Immutable private certificates are published only AFTER every tree descendant
 * has passed hash/type validation and storage. Ordinary object uploads cannot
 * create certificates. A present loose tree (including an orphan) is no proof.
 * Summary bounds are relative, so reuse at a deeper/longer path is checked too.
 */
export async function importCloudBatch(project: string, bucket: R2Bucket, work: ImportWork, trusted: Set<string>, readRemote: (hash: string, type: ImportItem['type']) => Promise<Uint8Array>, active: () => void, deadline: number, baselineHead?: string) {
    const git = new GitStore(bucket, project);
    const key = (hash: string) => `${project}/verified-import-trees/v1/${hash}`;
    // Legacy seen entries were recorded before descendants completed. Restart
    // traversal once, retaining all downloaded objects but trusting none of them.
    if (work.importVersion !== 1) {
        insist(work.remote, 'invalid_revision', 'Import requires a remote head.', 400);
        work.todo = [{ hash: work.remote, type: 'commit' }]; work.seen = []; work.importVersion = 1;
    }
    if (baselineHead && trusted.has(baselineHead) && !work.importBaselineTree) {
        const baseline = await git.read(baselineHead);
        insist(baseline.type === 'commit', 'invalid_object', 'Import baseline requires a commit.', 400);
        references('commit', baseline.body);
        work.importBaselineTree = new TextDecoder().decode(baseline.body).split('\n\n')[0].match(/^tree ([a-f0-9]{40})$/m)![1];
    }
    const seen = new Set(work.seen);
    const complete = (item: ImportItem, closure?: TreeClosure) => {
        work.todo.pop();
        const id = `${item.type}:${item.hash}${item.type === 'tree' ? `:${item.depth ?? 0}:${item.path ?? ''}` : ''}`;
        if (!seen.has(id)) { seen.add(id); work.seen.push(id); }
        if (closure) {
            const parent = work.todo.findLast(entry => entry.type === 'tree' && entry.expanded);
            if (parent) {
                const prefix = (item.path?.length ?? 0) - (parent.path?.length ?? 0);
                parent.closure!.depth = Math.max(parent.closure!.depth, closure.depth + 1);
                parent.closure!.path = Math.max(parent.closure!.path, prefix + closure.path - (closure.path === 0 ? 1 : 0));
            }
        }
        capacity(work);
    };
    for (let count = 0; count < IMPORT_BATCH && work.todo.length && Date.now() < deadline; count++) {
        active();
        const item = work.todo.at(-1)!;
        if (item.type === 'tree') {
            if (item.expanded) {
                checkContext(item, item.closure!);
                await bucket.put(key(item.hash), JSON.stringify(item.closure));
                complete(item, item.closure); continue;
            }
            const stored = await bucket.get(key(item.hash));
            if (stored) {
                let value: unknown;
                try { value = JSON.parse(await stored.text()); } catch { /* Rebuild malformed cache entries. */ }
                if (certificate(value, item.hash)) { checkContext(item, value); complete(item, value); continue; }
            }
        } else if (seen.has(`${item.type}:${item.hash}`) || (item.type === 'commit' && trusted.has(item.hash))) {
            complete(item); continue;
        }
        // One read replaces the old HEAD + GET pair for local objects.
        const stored = await bucket.get(git.key(item.hash));
        const decoded = stored ? decodeObject(new Uint8Array(await stored.arrayBuffer())) : null;
        insist(!decoded || decoded.type === item.type, 'invalid_object', 'Stored Git object has an unexpected type.', 400);
        const body = decoded?.body ?? await readRemote(item.hash, item.type), verified = await object(item.type, body);
        insist(verified.oid === item.hash, 'invalid_object', 'Stored Git object hash/type mismatch.', 400);
        if (!stored) await bucket.put(git.key(item.hash), deflateSync(verified.raw));
        let next: ImportItem[] = [];
        if (item.type === 'tree') {
            const entries = parseTree(body);
            item.closure = { version: 1, hash: item.hash, depth: 0, path: entries.reduce((max, entry) => Math.max(max, entry.name.length), 0) };
            checkContext(item, item.closure);
            item.expanded = true;
            const old = item.baseline ? await git.read(item.baseline) : null;
            insist(!old || old.type === 'tree', 'invalid_object', 'Import baseline requires a tree.', 400);
            const baseline = new Map(old ? parseTree(old.body).map(entry => [entry.name, entry]) : []);
            next = entries.flatMap(entry => {
                if (entry.mode === '160000') return [];
                const type = entry.mode === '40000' ? 'tree' : 'blob', previous = baseline.get(entry.name);
                const sameType = previous && (previous.mode === '40000' ? 'tree' : previous.mode === '160000' ? 'commit' : 'blob') === type;
                // Canonical baseline closure proves these exact blobs exist.
                // Trees still use certificates or accumulate exact summaries;
                // skipping them blindly would understate future path/depth bounds.
                if (type === 'blob' && sameType && previous.oid === entry.oid) return [];
                return [{ hash: entry.oid, type, baseline: type === 'tree' && sameType ? previous.oid : undefined, depth: (item.depth ?? 0) + 1, path: `${item.path ?? ''}${entry.name}/` }];
            });
        } else {
            if (item.type === 'commit') {
                references('commit', body);
                const header = new TextDecoder().decode(body).split('\n\n')[0];
                next = [...header.matchAll(/^(tree|parent) ([a-f0-9]{40})$/gm)].map(entry => ({ hash: entry[2], type: entry[1] === 'tree' ? 'tree' : 'commit', ...(entry[1] === 'tree' ? { depth: 0, path: '', baseline: work.importBaselineTree } : {}) }));
            }
            complete(item);
        }
        work.todo.push(...next);
        capacity(work);
    }
}
