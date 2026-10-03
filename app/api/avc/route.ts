import { bindings, readProject, mutate } from '@/lib/avc/storage';
import { authorize, sameOrigin, digest, token } from '@/lib/avc/auth';
import { GitStore } from '@/lib/avc/git';
import { type State, type Files, type Journey, type BreakingChange, ProtocolError, insist, emit, getJourney, activeJourney, acquire, recordPatch, checkTokens, validateSubmission, finalizeIntegration, mergeFiles, remap, diff, publicState, notifyWaiters, pendingIntegrations, expire, updatePolicy, approvalAuthority, validateIntegrationAuthority, approvalInbox } from '@/lib/avc/core';
export const dynamic = 'force-dynamic';
import { submitForReview, reconciliationPlan, recordReconciliation } from '@/lib/avc/core';
import { integrationFiles } from '@/lib/avc/integration';
const sample: Files = { 'src/users.rs': 'pub struct User {\n    pub id: u64,\n    pub name: String,\n}\n\npub fn find_user(id: u64) -> Option<User> {\n    if id == 1 {\n        Some(User { id, name: "Ada".into() })\n    } else {\n        None\n    }\n}\n\npub fn display_name(user: &User) -> String {\n    user.name.clone()\n}\n', 'Cargo.toml': '[package]\nname = "journey-demo"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/users.rs"\n', 'README.md': '# Journey demo\n\nA small Rust library for trying concurrent range locks and recorded changesets.\n\nRun cargo test locally. CI is optional.\n' };
const field = (v: unknown, name: string, max = 4000) => { insist(typeof v === 'string' && v.trim().length > 0 && v.length <= max, 'invalid_input', `${name} is required (maximum ${max} characters).`, 400); return v.trim(); };
function error(e: unknown) { const p = e as ProtocolError; return Response.json({ error: p.message ?? 'Unexpected server error.', code: p.code ?? 'server_error', details: p.details }, { status: p.status ?? 500 }); }
async function legacyActorRoles(project: string) {
    const rows = await bindings().db.prepare('SELECT digest,role FROM agents WHERE project=?').bind(project).all<{ digest: string; role: string }>();
    return Object.fromEntries(rows.results.map(row => ['agent:' + row.digest.slice(0, 16), row.role]));
}
export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const id = url.searchParams.get('project');
        const user = await authorize(req, id ?? undefined);
        if (!id) {
            insist(!user.agent, 'project_required', 'Agents must specify a repository.', 400);
            const rows = await bindings().db.prepare('SELECT id,name FROM projects WHERE owner=?').bind(user.id).all();
            return Response.json({ projects: rows.results, user });
        }
        let row = await readProject(id);
        if (row.state.leases.some(l => l.expires <= Date.now())) {
            await mutate(id, () => null);
            row = await readProject(id);
        }
        if (url.searchParams.get('approvals') === '1') return Response.json(approvalInbox(row.state, user, Number(url.searchParams.get('since') ?? 0), await legacyActorRoles(id)));
        const git = new GitStore(bindings().bucket, id);
        const revision = url.searchParams.get('revision');
        if (revision) {
            insist(row.state.revisions[revision], 'revision_not_found', 'Revision is not part of this repository.', 404);
            return Response.json({ revision, files: await git.files(revision) });
        }
        const journey = url.searchParams.get('journey');
        if (journey) {
            const j = getJourney(row.state, journey);
            insist(!user.agent || j.actor === user.id, 'forbidden', 'This inbox belongs to another agent.', 403);
            const since = Number(url.searchParams.get('since') ?? 0);
            insist(Number.isSafeInteger(since) && since >= 0, 'invalid_cursor', 'Invalid event cursor.', 400);
            return Response.json({ events: row.state.events.filter(e => e.id > since && (e.targets.includes(journey) || e.journey === journey)), cursor: row.state.sequence, integrationCursor: row.state.integrationCursor });
        }
        return Response.json({ state: publicState(row.state, user.id, user.agent), user });
    }
    catch (e) {
        return error(e);
    }
}
export async function POST(req: Request) {
    try {
        sameOrigin(req);
        const text = await req.text();
        insist(text.length < 1000000, 'request_too_large', 'Request exceeds 1 MB.', 413);
        const b = JSON.parse(text);
        const action = field(b.action, 'Action', 40);
        const user = await authorize(req, b.project);
        if (action === 'create_project') {
            insist(!user.agent, 'forbidden', 'Only humans can create repositories.', 403);
            const name = field(b.name, 'Repository name', 80), id = crypto.randomUUID();
            const git = new GitStore(bindings().bucket, id);
            const files = b.files ?? (b.empty ? {} : sample);
            insist(files && typeof files === 'object' && !Array.isArray(files) && Object.values(files).every(v => typeof v === 'string'), 'invalid_files', 'Files must map paths to text.', 400);
            const c = await git.save(files, undefined, 'Initialize repository', user.name);
            const s: State = { id, name, head: c.oid, revisions: { [c.oid]: c.meta }, journeys: [], leases: [], waiting: [], events: [], sequence: 0, integrationCursor: 0, generation: 0, receipts: {}, requireApproval: true, allowWorkerMerge: true, allowCoordinatorApproval: false };
            emit(s, 'repository.created', user.id, { name, revision: c.oid });
            await bindings().db.prepare('INSERT INTO projects(id,owner,name,state) VALUES(?,?,?,?)').bind(id, user.id, name, JSON.stringify(s)).run();
            return Response.json({ project: id });
        }
        insist(b.project, 'project_required', 'Specify a repository.', 400);
        const id = b.project as string;
        const git = new GitStore(bindings().bucket, id);
        if (action === 'create_agent' || action === 'delegate_agent') {
            insist(!user.agent || (action === 'delegate_agent' && user.role === 'coordinator'), 'forbidden', 'Only humans or a repository coordinator can issue worker credentials.', 403);
            const name = field(b.name, 'Agent name', 80);
            const raw = token();
            const hash = await digest(raw);
            await bindings().db.prepare('INSERT INTO agents(digest,project,name,role,created) VALUES(?,?,?,?,?)').bind(hash, id, name, !user.agent && b.coordinator ? 'coordinator' : 'worker', Date.now()).run();
            return Response.json({ token: raw, name, actor: 'agent:' + hash.slice(0, 16) });
        }
        if (action === 'revoke_agent') {
            insist(!user.agent, 'forbidden', 'Only humans can revoke credentials.', 403);
            await bindings().db.prepare('DELETE FROM agents WHERE digest=? AND project=?').bind(await digest(field(b.token, 'Token', 100)), id).run();
            return Response.json({ ok: true });
        }
        const legacyRoles = action === 'review' && b.kind === 'approve' && user.agent ? await legacyActorRoles(id) : {};
        const requestId = field(b.requestId, 'Request ID', 100);
        const result = await mutate(id, async (s) => {
            const receipt = s.receipts[user.id + ':' + requestId] as {
                request: string;
                result: unknown;
            } | undefined;
            const fingerprint = await digest(text);
            if (receipt) {
                insist(receipt.request === fingerprint, 'idempotency_conflict', 'This request ID was already used with a different payload.');
                return receipt.result;
            }
            let result: unknown;
            if (action === 'create_journey') {
                insist(!s.importSession, 'import_in_progress', 'Finish or cancel the repository import before starting journeys.');
                const title = field(b.title, 'Journey title', 150);
                const j: Journey = { id: crypto.randomUUID(), title, description: field(b.description ?? title, 'Description'), actor: user.id, actorRole: user.agent ? user.role === 'coordinator' ? 'coordinator' : 'worker' : 'human', status: 'working', base: s.head, head: s.head, reconciledHead: s.head, reconciledCursor: s.integrationCursor, changesets: [], manifest: [], manifestDeclared: false, reviews: [], dispositions: {}, created: Date.now() };
                s.journeys.push(j);
                emit(s, 'journey.created', user.id, { title }, j.id, [j.id]);
                result = { journey: j.id };
            }
            else if (action === 'policy') {
                const policy = updatePolicy(s, b, user);
                emit(s, 'policy.changed', user.id, policy);
                result = { ok: true, policy };
            }
            else {
                const j = action === 'review' || action === 'resolve_review' ? getJourney(s, field(b.journey, 'Journey ID', 100)) : activeJourney(s, field(b.journey, 'Journey ID', 100));
                insist(!user.agent || j.actor === user.id || action === 'review', 'forbidden', 'Only the owning agent may modify this journey.', 403);
                switch (action) {
                    case 'create_changeset': {
                        insist(j.changesets.length < 100, 'changeset_capacity', 'MVP supports 100 changesets per journey.', 413);
                        const c = { id: crypto.randomUUID(), description: field(b.description, 'Changeset description'), patches: [] };
                        j.changesets.push(c);
                        emit(s, 'changeset.created', user.id, { changeset: c.id, description: c.description }, j.id, [j.id]);
                        result = { changeset: c.id };
                        break;
                    }
                    case 'acquire': {
                        insist(s.revisions[b.revision] || (await git.read(b.revision)).type === 'commit', 'revision_not_found', 'Unknown revision.', 404);
                        result = acquire(s, j, b.changeset, b.scopes, b.revision, await git.files(b.revision), await git.files(s.head), user.id, Date.now(), await git.files(j.head));
                        break;
                    }
                    case 'record': {
                        insist(['command', 'explanation', 'decision'].includes(b.kind), 'invalid_recording', 'Choose command, explanation, or decision.', 400);
                        insist(['captured', 'reconstructed'].includes(b.provenance), 'invalid_provenance', 'Declare captured or reconstructed provenance.', 400);
                        const description = field(b.description, 'Recording description');
                        const data: Record<string, unknown> = { kind: b.kind, description, provenance: b.provenance, revision: j.head };
                        if (b.kind === 'command') {
                            data.command = field(b.command, 'Command');
                            insist(typeof b.output === 'string' && b.output.length <= 12000, 'invalid_output', 'Command output must be text, up to 12,000 characters.', 400);
                            insist(Number.isInteger(b.exitCode), 'invalid_exit_code', 'Supply the command exit code.', 400);
                            data.output = b.output;
                            data.exitCode = b.exitCode;
                        }
                        if (b.changeset) {
                            insist(j.changesets.some(c => c.id === b.changeset), 'changeset_not_found', 'Invalid recording anchor.', 404);
                            data.changeset = b.changeset;
                        }
                        const event = emit(s, 'recording.recorded', user.id, data, j.id, [j.id]);
                        result = { event: event.id };
                        break;
                    }
                    case 'refresh': {
                        insist(Array.isArray(b.tokens) && b.tokens.length, 'tokens_required', 'Supply lock tokens.', 400);
                        const held = s.leases.filter(l => l.journey === j.id && b.tokens.includes(l.token));
                        insist(held.length === new Set(b.tokens).size, 'invalid_lease', 'A lock expired or the token is invalid.');
                        held.forEach(l => l.expires = Date.now() + 600000);
                        result = { locks: held };
                        break;
                    }
                    case 'patch': {
                        insist(b.revision === j.head, 'stale_revision', 'The journey revision changed. Refresh before patching.');
                        const description = field(b.description, 'Patch description');
                        const before = await git.files(j.head);
                        const files: Files = Object.assign(Object.create(null), before);
                        insist(Array.isArray(b.edits) && b.edits.length > 0 && b.edits.length <= 80, 'invalid_edits', 'Supply 1–80 edits.', 400);
                        for (const e of b.edits) {
                            const path = field(e.path, 'File path', 200);
                            insist(e.content === null || typeof e.content === 'string', 'invalid_content', 'Content must be text, or null to delete.', 400);
                            if (e.content === null)
                                delete files[path];
                            else
                                files[path] = e.content;
                        }
                        const c = await git.save(files, j.head, description, user.name);
                        const patch = recordPatch(s, j, b.changeset, files, before, c.oid, description, user.id, b.tokens ?? []);
                        s.revisions[c.oid] = c.meta;
                        result = { patch: patch.id, revision: c.oid };
                        break;
                    }
                    case 'declare_breaking': {
                        insist(Array.isArray(b.changes) && b.changes.length <= 100, 'invalid_manifest', 'Supply a breaking-change list, including an empty list when there are none.', 400);
                        j.manifest = b.changes.map((c: BreakingChange) => ({ target: field(c.target, 'Target', 200), kind: field(c.kind, 'Kind', 100), before: field(c.before, 'Before'), after: field(c.after, 'After'), migration: field(c.migration, 'Migration') }));
                        j.manifestDeclared = true;
                        emit(s, 'manifest.updated', user.id, { changes: j.manifest, revision: j.head }, j.id, [j.id]);
                        j.status = 'working'; // Approval binds both code and the declared compatibility contract.
                        j.reviews.forEach(r => { if (r.kind === 'approve')
                            r.resolved = true; });
                        result = { ok: true };
                        break;
                    }
                    case 'submit': {
                        result = submitForReview(s, j, b.revision, user.id);
                        break;
                    }
                    case 'review': {
                        insist(j.status === 'review', 'not_in_review', 'The journey must be submitted for review.');
                        insist(['comment', 'request_changes', 'approve'].includes(b.kind), 'invalid_review', 'Unknown review action.', 400);
                        const authority = b.kind === 'approve' ? approvalAuthority(s, j, user, legacyRoles) : undefined;
                        insist(b.revision === j.head, 'stale_review', 'This review targets an old revision.');
                        if (b.changeset)
                            insist(j.changesets.some(c => c.id === b.changeset), 'changeset_not_found', 'Invalid review anchor.', 404);
                        if (b.patch)
                            insist(j.changesets.some(c => c.patches.some(p => p.id === b.patch)), 'patch_not_found', 'Invalid patch anchor.', 404);
                        if (b.kind === 'approve')
                            validateSubmission(s, j);
                        const r = { id: crypto.randomUUID(), actor: user.id, body: field(b.body ?? (b.kind === 'approve' ? 'Approved' : 'Review'), 'Review text'), kind: b.kind, revision: j.head, at: Date.now(), ...(authority ? { authority } : {}), ...(b.changeset ? { changeset: b.changeset } : {}), ...(b.patch ? { patch: b.patch } : {}) };
                        j.reviews.push(r);
                        emit(s, b.kind === 'approve' ? 'review.approved' : b.kind === 'request_changes' ? 'review.changes_requested' : 'review.commented', user.id, { review: r.id, body: r.body, revision: j.head, ...(authority ? { authority } : {}) }, j.id, [j.id]);
                        result = { review: r.id };
                        break;
                    }
                    case 'resolve_review': {
                        const r = j.reviews.find(r => r.id === b.review && r.kind === 'request_changes');
                        insist(r, 'review_not_found', 'Change request not found.', 404);
                        r.resolved = true;
                        emit(s, 'review.resolved', user.id, { review: r.id }, j.id, [j.id]);
                        result = { ok: true };
                        break;
                    }
                    case 'reconcile': {
                        insist(b.head === s.head && b.cursor === s.integrationCursor, 'stale_reconciliation', 'The integration head changed. Fetch the new events.');
                        const plan = reconciliationPlan(s, j, b.dispositions);
                        if (plan.current) {
                            result = { revision: j.head, status: j.status, manifestDeclared: j.manifestDeclared, unchanged: true };
                            break;
                        }
                        const old = await git.files(j.head);
                        const base = await git.files(j.base);
                        const canonical = await git.files(s.head);
                        const merged = mergeFiles(base, old, canonical);
                        const c = await git.save(merged, j.head, 'Reconcile accepted journeys', user.name);
                        for (const l of s.leases.filter(l => l.journey === j.id)) {
                            if (l.whole)
                                continue;
                            const [start, end] = remap(l.start - 1, l.end, diff(old[l.path] ?? '', merged[l.path] ?? ''));
                            l.start = start + 1;
                            l.end = end;
                            l.revision = c.oid;
                        }
                        s.revisions[c.oid] = c.meta;
                        result = recordReconciliation(s, j, c.oid, b.dispositions, user.id);
                        break;
                    }
                    case 'integrate': {
                        insist(j.status === 'review', 'not_in_review', 'Submit the journey for review first.');
                        insist(b.revision === j.head && b.head === s.head && b.cursor === s.integrationCursor, 'stale_integration', 'The candidate or integration head changed.');
                        if (user.agent) checkTokens(s, j, b.tokens ?? []);
                        validateSubmission(s, j);
                        validateIntegrationAuthority(s, j, user);
                        break;
                    }
                    case 'abandon': {
                        j.status = 'abandoned';
                        s.leases = s.leases.filter(l => l.journey !== j.id);
                        s.waiting = s.waiting.filter(w => w.journey !== j.id);
                        emit(s, 'journey.abandoned', user.id, {}, j.id, [j.id]);
                        notifyWaiters(s);
                        result = { ok: true };
                        break;
                    }
                    default: throw new ProtocolError('unknown_action', 'Unknown action.', 400);
                }
                // Integration validates the final diff against canonical lock coordinates before atomically advancing the state.
                if (action === 'integrate') {
                    const canonical = await git.files(s.head), base = await git.files(j.base), ours = await git.files(j.head);
                    const merged = integrationFiles(s, j, canonical, base, ours, b.tokens ?? [], !user.agent);
                    const c = await git.save(merged, s.head, j.title, user.name);
                    s.revisions[c.oid] = c.meta;
                    const e = finalizeIntegration(s, j, c.oid, user.id, canonical, merged);
                    result = { revision: c.oid, event: e.id };
                }
            }
            s.receipts[user.id + ':' + requestId] = { request: fingerprint, result };
            return result;
        });
        return Response.json({ result });
    }
    catch (e) {
        return error(e);
    }
}
