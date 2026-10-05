import { insist, type State } from './core.ts';
import { references } from './git.ts';

export type Visibility = 'private' | 'public';
export type RepositorySummary = {
    id: string;
    name: string;
    visibility: Visibility;
    owner: { username: string };
    permissions: { read: true; write: boolean };
};
export function visibility(value: unknown): Visibility {
    insist(value === 'private' || value === 'public', 'invalid_visibility', 'Choose private or public repository visibility.', 400);
    return value;
}
export function canManageRepository(user: { id: string; agent: boolean; project?: string } | null, project: { id: string; owner: string }) {
    return !!user && (user.agent ? user.project === project.id : user.id === project.owner);
}
export function repositorySummary(row: { id: string; name: string; owner: string; username?: string | null; visibility: Visibility }, user: { id: string; agent: boolean; project?: string } | null): RepositorySummary {
    return { id: row.id, name: row.name, visibility: row.visibility, owner: { username: row.username || 'Repository owner' }, permissions: { read: true, write: canManageRepository(user, row) } };
}
// Construct an allowlisted projection. Adding a private State field must never
// accidentally make it visible to anonymous visitors or another account.
export function readerState(state: State): State {
    const revisions: State['revisions'] = {};
    let revision: string | undefined = state.head;
    while (revision && state.revisions[revision] && !revisions[revision]) {
        const { parent, message, at }: State['revisions'][string] = state.revisions[revision];
        revisions[revision] = { ...(parent ? { parent } : {}), message, at, actor: 'Repository contributor' };
        revision = parent;
    }
    return { id: state.id, name: state.name, head: state.head, revisions, journeys: [], leases: [], waiting: [], events: [], sequence: 0, integrationCursor: 0, generation: 0, receipts: {}, requireApproval: true, allowWorkerMerge: false, allowCoordinatorApproval: false };
}
type ObjectReader = { read(oid: string): Promise<{ type: string; body: Uint8Array }> };
// Public Git advertises main only. The complete reachable object graph is
// checked, including trees/blobs, so a guessed draft hash grants no access.
export async function acceptedObjects(git: ObjectReader, head: string): Promise<Set<string>> {
    const seen = new Set<string>(), pending = [head];
    while (pending.length) {
        const batch: string[] = [];
        while (pending.length && batch.length < 4) {
            const oid = pending.pop()!;
            if (seen.has(oid)) continue;
            seen.add(oid); batch.push(oid);
            insist(seen.size <= 50000, 'public_history_capacity', 'Repository history exceeds the public browsing limit.', 413);
        }
        const reads = await Promise.allSettled(batch.map(oid => git.read(oid)));
        for (const result of reads) {
            if (result.status === 'rejected') throw result.reason;
            pending.push(...references(result.value.type, result.value.body));
        }
    }
    return seen;
}
export async function acceptedRevision(git: ObjectReader, head: string, target: string): Promise<boolean> {
    if (!/^[a-f0-9]{40}$/.test(target)) return false;
    const visited = new Set<string>(), pending = [head];
    while (pending.length) {
        const oid = pending.pop()!;
        if (visited.has(oid)) continue;
        if (oid === target) return true;
        visited.add(oid);
        insist(visited.size <= 10000, 'public_history_capacity', 'Repository history exceeds the public browsing limit.', 413);
        const object = await git.read(oid);
        insist(object.type === 'commit', 'invalid_revision', 'Expected a Git commit.', 400);
        pending.push(...[...new TextDecoder().decode(object.body).split('\n\n')[0].matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]));
    }
    return false;
}
