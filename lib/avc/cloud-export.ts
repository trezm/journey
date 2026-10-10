import { insist } from './core.ts';
import { parseTree, references, type GitStore } from './git.ts';
import type { ImportItem } from './cloud-import.ts';

export type ExportItem = ImportItem & { baseline?: string; checked?: boolean };
export type ExportWork = { original: string; remote: string | null; todo: ExportItem[]; seen: string[]; transferHead?: string; exportVersion?: 1; baselineTree?: string };
type Transport = {
    has(hash: string, type: 'commit' | 'tree' | 'blob'): Promise<boolean>;
    head(branch: string): Promise<string | null>;
    write(hash: string, type: 'tree' | 'blob', body: Uint8Array): Promise<unknown>;
    push(ref: string, old: string | null, hash: string, body?: Uint8Array): Promise<unknown>;
};
function treeOf(body: Uint8Array) {
    references('commit', body);
    return new TextDecoder().decode(body).split('\n\n')[0].match(/^tree ([a-f0-9]{40})$/m)![1];
}
/** Only objects reachable from the captured remote commit are reusable without
 * probing the provider. Local presence is never evidence of remote presence. */
export async function exportCloudBatch(work: ExportWork, git: GitStore, remote: Transport, branch: string, active: () => void, beforeWrite: () => Promise<void>, deadline: number) {
    if (work.exportVersion !== 1) {
        work.todo = [{ hash: work.original, type: 'commit' }]; work.seen = []; work.exportVersion = 1;
        if (work.remote) {
            const baseline = await git.read(work.remote);
            insist(baseline.type === 'commit', 'invalid_object', 'Export baseline requires a commit.', 400);
            work.baselineTree = treeOf(baseline.body);
        }
    }
    const seen = new Set(work.seen);
    const complete = (item: ExportItem) => { work.todo.pop(); if (!seen.has(item.hash)) { seen.add(item.hash); work.seen.push(item.hash); } };
    for (let count = 0; count < 100 && work.todo.length && Date.now() < deadline; count++) {
        active();
        const item = work.todo.at(-1)!;
        if (seen.has(item.hash) || item.hash === work.remote || item.hash === item.baseline) { complete(item); continue; }
        if (!item.checked && !item.expanded) {
            if (await remote.has(item.hash, item.type)) {
                if (item.type === 'commit') {
                    const published = await remote.head(branch);
                    insist(published === null || published === work.transferHead || published === item.hash, 'conflict_ref_exists', 'The preservation branch changed; it was not overwritten.', 409);
                    if (published === item.hash) work.transferHead = item.hash;
                }
                complete(item);
                // Persist recovered commit acknowledgements before another push.
                if (item.type === 'commit') break;
                continue;
            }
            item.checked = true;
        }
        const value = await git.read(item.hash);
        insist(value.type === item.type, 'invalid_object', 'Git object has an unexpected type.', 400);
        if (!item.expanded && item.type !== 'blob') {
            let next: ExportItem[];
            if (item.type === 'commit') {
                const tree = treeOf(value.body);
                next = [{ hash: tree, type: 'tree', baseline: work.baselineTree, depth: 0, path: '' }, ...[...new TextDecoder().decode(value.body).split('\n\n')[0].matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => ({ hash: match[1], type: 'commit' as const }))];
            } else {
                insist((item.depth ?? 0) <= 40, 'tree_capacity', 'Git tree nesting exceeds Journey’s tree depth limit.', 413);
                const old = item.baseline ? await git.read(item.baseline) : null;
                insist(!old || old.type === 'tree', 'invalid_object', 'Export baseline requires a tree.', 400);
                const baseline = new Map(old ? parseTree(old.body).map(entry => [entry.name, entry]) : []);
                next = parseTree(value.body).flatMap(entry => {
                    const path = `${item.path ?? ''}${entry.name}`;
                    insist(path.length <= 1000, 'tree_capacity', 'Git tree path exceeds Journey’s path limit.', 413);
                    if (entry.mode === '160000') return [];
                    const type = entry.mode === '40000' ? 'tree' : 'blob', previous = baseline.get(entry.name);
                    const sameType = previous && (previous.mode === '40000' ? 'tree' : previous.mode === '160000' ? 'commit' : 'blob') === type;
                    if (sameType && previous.oid === entry.oid) return [];
                    return [{ hash: entry.oid, type, baseline: sameType && type === 'tree' ? previous.oid : undefined, depth: (item.depth ?? 0) + 1, path: path + '/' }];
                });
            }
            item.expanded = true;
            work.todo.push(...next.filter(child => !seen.has(child.hash)));
            insist(work.todo.length <= 50_000, 'sync_capacity', 'Object traversal capacity exceeded.', 413);
            if (next.length) continue;
        }
        if (item.type === 'commit') {
            const old = await remote.head(branch);
            insist(old === null || old === work.transferHead || old === item.hash, 'conflict_ref_exists', 'The preservation branch changed; it was not overwritten.', 409);
            if (old !== item.hash) { await beforeWrite(); await remote.push(`refs/heads/${branch}`, old, item.hash, value.body); }
            work.transferHead = item.hash;
        } else { await beforeWrite(); await remote.write(item.hash, item.type, value.body); }
        complete(item);
        insist(work.seen.length <= 50_000, 'sync_capacity', 'Cloud sync exceeds 50,000 objects; heads are preserved.', 413);
        // Never perform multiple scratch ref mutations in one checkpoint. If its
        // acknowledgement is lost, only this exact commit can be ahead of state.
        if (item.type === 'commit') break;
    }
}
