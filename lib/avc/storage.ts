import { env } from 'cloudflare:workers';
import { type State, insist, ProtocolError, expire } from './core.ts';
export function bindings() { insist(env.DB && env.BUCKET, 'storage_unavailable', 'Repository storage is unavailable.', 503); return { db: env.DB!, bucket: env.BUCKET! }; }
export async function readProject(id: string) { const { db } = bindings(); const row = await db.prepare('SELECT id,owner,name,version,state FROM projects WHERE id=?').bind(id).first<{
    id: string;
    owner: string;
    name: string;
    version: number;
    state: string;
}>(); insist(row, 'project_not_found', 'Repository not found.', 404); return { ...row, state: JSON.parse(row.state) as State }; }
export async function mutate<T>(id: string, fn: (s: State) => Promise<T> | T): Promise<T> { const { db } = bindings(); for (let attempt = 0; attempt < 5; attempt++) {
    const row = await readProject(id);
    expire(row.state);
    const result = await fn(row.state);
    const serialized = JSON.stringify(row.state);
    insist(serialized.length < 1500000, 'project_capacity', 'MVP metadata capacity reached. Export the repository.', 413);
    const update = await db.prepare('UPDATE projects SET state=?,version=version+1 WHERE id=? AND version=?').bind(serialized, id, row.version).run();
    if (update.meta.changes === 1)
        return result;
} throw new ProtocolError('concurrent_update', 'Concurrent update. Retry with the same request ID.', 409); }
