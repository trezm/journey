import { readableRepository, privateResponseHeaders } from '@/lib/avc/repository-access';
import { acceptedObjects } from '@/lib/avc/repository-visibility';
import { bindings } from '@/lib/avc/storage';
import { GitStore } from '@/lib/avc/git';
import { ProtocolError, insist } from '@/lib/avc/core';
export async function GET(req: Request, { params }: { params: Promise<{ project: string; path: string[] }> }) {
    try {
        const { project, path } = await params;
        const { row, write } = await readableRepository(req, project);
        const p = path.join('/');
        if (p === 'HEAD') return new Response('ref: refs/heads/main\n', { headers: { ...privateResponseHeaders, 'Content-Type': 'text/plain' } });
        if (p === 'info/refs') {
            const refs = [`${row.state.head}\trefs/heads/main`];
            if (write) refs.push(...Object.entries(row.state.imported?.refs ?? {}).filter(([ref]) => ref !== 'refs/heads/main' && !Object.hasOwn(row.state.sync?.backupRefs ?? {}, ref)).map(([ref, oid]) => `${oid}\t${ref}`), ...Object.entries(row.state.sync?.backupRefs ?? {}).map(([ref, oid]) => `${oid}\t${ref}`), ...row.state.journeys.map(j => `${j.head}\trefs/heads/journeys/${j.id}`));
            return new Response(refs.join('\n') + '\n', { headers: { ...privateResponseHeaders, 'Content-Type': 'text/plain' } });
        }
        insist(/^objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(p), 'not_found', 'Git object not found.', 404);
        const { bucket } = bindings(), git = new GitStore(bucket, project);
        if (!write) {
            const oid = p.slice(8).replace('/', ''), cacheKey = `${project}/public-objects/${row.state.head}`;
            const cached = await bucket.get(cacheKey);
            const allowed = cached ? new Set<string>(await cached.json<string[]>()) : await acceptedObjects(git, row.state.head);
            insist(allowed.has(oid), 'not_found', 'Git object not found.', 404);
            if (!cached) await bucket.put(cacheKey, JSON.stringify([...allowed]));
        }
        const object = await git.gitObject(p);
        insist(object, 'not_found', 'Git object not found.', 404);
        return new Response(object.body, { headers: { ...privateResponseHeaders, 'Content-Type': 'application/octet-stream' } });
    } catch (e) {
        const p = e as ProtocolError;
        return Response.json({ error: p.message, code: p.code }, { status: p.status ?? 500, headers: { ...privateResponseHeaders, ...(p.status === 401 ? { 'WWW-Authenticate': 'Basic realm="Journey repository"' } : {}) } });
    }
}
