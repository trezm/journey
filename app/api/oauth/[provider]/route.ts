import { authorize, authenticationMode, sameOrigin } from '@/lib/avc/auth';
import { insist, ProtocolError } from '@/lib/avc/core';
import { syncBody } from '@/lib/avc/sync-git';
import { configured, connection, provider, repositories, sessionBinding, startOAuth } from '@/lib/avc/oauth';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ provider: string }> };
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
function failure(error: unknown) { return Response.json({ error: error instanceof ProtocolError ? error.message : 'Account connection could not be completed.', code: error instanceof ProtocolError ? error.code : 'oauth_error' }, { status: error instanceof ProtocolError ? error.status : 500, headers }); }
export async function GET(req: Request, context: Context) {
    try {
        const p = provider((await context.params).provider), url = new URL(req.url), project = url.searchParams.get('project');
        insist(project, 'invalid_project', 'Select a repository first.', 400);
        const user = await authorize(req, project); insist(!user.agent, 'forbidden', 'Only the repository owner can connect a provider account.', 403);
        const current = await connection(user.id, p);
        return Response.json({ configured: configured(p), connection: current ? { provider: p, username: current.username } : null, ...(url.searchParams.has('repos') && current ? await repositories(user.id, p, Number(url.searchParams.get('page') ?? '1')) : {}) }, { headers });
    } catch (error) { return failure(error); }
}
export async function POST(req: Request, context: Context) {
    try {
        sameOrigin(req);
        insist(req.headers.get('origin') === new URL(req.url).origin, 'origin_denied', 'Start the connection from repository settings.', 403);
        const p = provider((await context.params).provider), raw = await syncBody(req, 4000);
        let body: { project?: unknown }; try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new ProtocolError('invalid_request', 'Supply a repository.', 400); }
        insist(body && typeof body.project === 'string' && body.project.length <= 100, 'invalid_project', 'Select a repository first.', 400);
        const user = await authorize(req, body.project); insist(!user.agent, 'forbidden', 'Only the repository owner can connect a provider account.', 403);
        const url = await startOAuth(p, user.id, await sessionBinding(req, authenticationMode() === 'access'), body.project, new URL(req.url).origin);
        return Response.json({ url }, { headers });
    } catch (error) { return failure(error); }
}
