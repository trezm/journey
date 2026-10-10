import { insist } from './core.ts';
import { references, type GitStore } from './git.ts';

export type Ancestry = { version: 1; turn: 'incoming' | 'outgoing'; incoming: string[]; outgoing: string[]; incomingSeen: string[]; outgoingSeen: string[] };
export type AncestryWork = { original: string; remote: string | null; ancestry?: Ancestry };
const LIMIT = 50_000;
/** Search both directions fairly. A remembered common head is only an ordering
 * hint: rewinds and force pushes still require a real ancestry proof. */
export async function ancestryCloudBatch(work: AncestryWork, git: GitStore, lastSynced: string | undefined, active: () => void, deadline: number): Promise<'incoming' | 'outgoing' | 'diverged' | undefined> {
    const search = work.ancestry ??= { version: 1, turn: work.remote === lastSynced ? 'outgoing' : 'incoming', incoming: [work.remote!], outgoing: [work.original], incomingSeen: [], outgoingSeen: [] };
    const visited = { incoming: new Set(search.incomingSeen), outgoing: new Set(search.outgoingSeen) };
    for (let count = 0; count < 100 && Date.now() < deadline; count++) {
        active();
        if (!search.incoming.length && !search.outgoing.length) return 'diverged';
        const side = search[search.turn].length ? search.turn : search.turn === 'incoming' ? 'outgoing' : 'incoming';
        search.turn = side === 'incoming' ? 'outgoing' : 'incoming';
        const hash = search[side].shift()!, target = side === 'incoming' ? work.original : work.remote;
        if (hash === target) return side;
        if (visited[side].has(hash)) continue;
        const opposite = side === 'incoming' ? 'outgoing' : 'incoming';
        if (visited[opposite].has(hash) || search[opposite].includes(hash)) {
            // A common ancestor cannot contain either distinct tip in an acyclic
            // Git graph. Prune only this path, keeping other merge-parent paths.
            visited[side].add(hash); search[side === 'incoming' ? 'incomingSeen' : 'outgoingSeen'].push(hash);
            insist(visited[side].size <= LIMIT, 'sync_capacity', 'Cloud sync ancestry exceeds 50,000 commits; heads are preserved.', 413);
            continue;
        }
        const value = await git.read(hash);
        insist(value.type === 'commit', 'invalid_object', 'Ancestry requires a commit.', 400);
        references('commit', value.body);
        const parents = [...new TextDecoder().decode(value.body).split('\n\n')[0].matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]);
        // Detect a direct parent before switching sides or checkpointing.
        if (parents.includes(target!)) return side;
        visited[side].add(hash); search[side === 'incoming' ? 'incomingSeen' : 'outgoingSeen'].push(hash);
        search[side].push(...parents.filter(parent => !visited[side].has(parent)));
        insist(visited[side].size <= LIMIT && search[side].length <= LIMIT, 'sync_capacity', 'Cloud sync ancestry exceeds 50,000 commits; heads are preserved.', 413);
    }
}
