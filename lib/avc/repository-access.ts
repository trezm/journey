import { principal } from './auth.ts';
import { bindings, readProject } from './storage.ts';
import { insist } from './core.ts';
import { canManageRepository, repositorySummary, type Visibility } from './repository-visibility.ts';

export const privateResponseHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' };
export async function repositoryPrincipal(req: Request) {
    const credential = req.headers.get('authorization');
    insist(credential === null || /^(Bearer|Basic)(?:\s|$)/i.test(credential), 'unauthorized', 'Invalid repository credential.', 401);
    const user = await principal(req);
    // Explicit credentials are authoritative: invalid tokens must not silently
    // fall back to public browsing, even when a valid session cookie is present.
    insist(user || !req.headers.has('authorization'), 'unauthorized', 'Invalid repository credential.', 401);
    return user;
}
export async function readableRepository(req: Request, id: string) {
    const user = await repositoryPrincipal(req);
    const row = await readProject(id);
    const write = canManageRepository(user, row);
    insist(write || (!user?.agent && row.visibility === 'public'), 'project_not_found', 'Repository not found.', 404);
    const owner = await bindings().db.prepare('SELECT username FROM users WHERE id=?').bind(row.owner).first<{ username: string }>();
    return { user, row, write, project: repositorySummary({ ...row, username: owner?.username }, user) };
}
export async function discoverRepositories(req: Request) {
    const user = await repositoryPrincipal(req);
    insist(!user?.agent, 'project_required', 'Agents must specify a repository.', 400);
    const rows = await bindings().db.prepare("SELECT projects.id,projects.name,projects.owner,projects.visibility,users.username FROM projects LEFT JOIN users ON users.id=projects.owner WHERE projects.owner=? OR projects.visibility='public' ORDER BY CASE WHEN projects.owner=? THEN 0 ELSE 1 END,projects.name,projects.id").bind(user?.id ?? '', user?.id ?? '').all<{ id: string; name: string; owner: string; visibility: Visibility; username: string | null }>();
    return { projects: rows.results.map(row => repositorySummary(row, user)), user };
}
