import { authorize } from '@/lib/avc/auth';
import { readProject, bindings } from '@/lib/avc/storage';
import { GitStore } from '@/lib/avc/git';
import { ProtocolError, insist } from '@/lib/avc/core';
export async function GET(req: Request, { params }: {
    params: Promise<{
        project: string;
        path: string[];
    }>;
}) { try {
    const { project, path } = await params;
    await authorize(req, project);
    const row = await readProject(project);
    const p = path.join('/');
    if (p === 'HEAD')
        return new Response('ref: refs/heads/main\n', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    if (p === 'info/refs') {
        const refs = [`${row.state.head}\trefs/heads/main`, ...Object.entries(row.state.imported?.refs ?? {}).filter(([ref]) => ref !== 'refs/heads/main').map(([ref, oid]) => `${oid}\t${ref}`), ...row.state.journeys.map(j => `${j.head}\trefs/heads/journeys/${j.id}`)];
        return new Response(refs.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
    insist(/^objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(p), 'not_found', 'Git object not found.', 404);
    const object = await new GitStore(bindings().bucket, project).gitObject(p);
    insist(object, 'not_found', 'Git object not found.', 404);
    return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000' } });
}
catch (e) {
    const p = e as ProtocolError;
    return Response.json({ error: p.message }, { status: p.status ?? 500, headers: { 'WWW-Authenticate': 'Basic realm="Journey repository"' } });
} }
