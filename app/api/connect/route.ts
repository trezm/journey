import { env } from 'cloudflare:workers';
import { authorize, sameOrigin, token, digest } from '@/lib/avc/auth';
import { bindings, readProject } from '@/lib/avc/storage';
import { insist, ProtocolError } from '@/lib/avc/core';
export async function POST(req: Request) {
    try {
        sameOrigin(req); const { project } = await req.json() as { project: string };
        const user = await authorize(req, project); insist(!user.agent, 'forbidden', 'Only the repository owner can download a coordinator connection.', 403);
        const row = await readProject(project), raw = token(), hash = await digest(raw);
        await bindings().db.prepare('INSERT INTO agents(digest,project,name,role,created) VALUES(?,?,?,?,?)').bind(hash, project, 'Codex coordinator', 'coordinator', Date.now()).run();
        const url = new URL(req.url).origin;
        return Response.json({ version: 1, url, project, name: row.name, token: raw, ...(env.JOURNEY_SITE_SERVICE_TOKEN ? { siteToken: env.JOURNEY_SITE_SERVICE_TOKEN } : {}) }, { headers: { 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="journey-connection.json"' } });
    } catch (e) { const p = e as ProtocolError; return Response.json({ error: p.message, code: p.code }, { status: p.status ?? 500 }); }
}
