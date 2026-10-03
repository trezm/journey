import { authorize, sameOrigin } from '@/lib/avc/auth';
import { bindings, readProject, mutate } from '@/lib/avc/storage';
import { GitStore, decodeObject, references, object } from '@/lib/avc/git';
import { insist, ProtocolError, emit } from '@/lib/avc/core';
import { assertSyncWritable } from '@/lib/avc/sync';
export const dynamic = 'force-dynamic';
type Descriptor = { oid: string; type: string; refs: string[] };
export async function POST(req: Request) {
    try {
        sameOrigin(req); const url = new URL(req.url), project = url.searchParams.get('project');
        insist(project, 'project_required', 'Specify a repository.', 400);
        const user = await authorize(req, project);
        insist(!user.agent || user.role === 'coordinator', 'forbidden', 'Import requires a repository coordinator credential.', 403);
        const op = url.searchParams.get('op'), git = new GitStore(bindings().bucket, project), bucket = bindings().bucket;
        if (op === 'start') {
            const result = await mutate(project, s => {
                assertSyncWritable(s);
                insist(!s.journeys.length && !s.imported, 'repository_in_use', 'Import into a new repository before starting journeys.');
                if (s.importSession) insist(s.importSession.actor === user.id || !user.agent, 'import_busy', 'Another coordinator owns this import.');
                else s.importSession = { id: crypto.randomUUID(), actor: user.id, started: Date.now() };
                return s.importSession;
            });
            return Response.json(result);
        }
        const session = url.searchParams.get('session'); const row = await readProject(project);
        assertSyncWritable(row.state);
        if (op === 'finish' && row.state.imported?.session === session) return Response.json({ head: row.state.head, imported: row.state.imported });
        insist(session && row.state.importSession?.id === session && (!user.agent || row.state.importSession.actor === user.id), 'invalid_import', 'Start an import with this coordinator first.');
        if (op === 'cancel') { await mutate(project, s => { insist(s.importSession?.id === session, 'invalid_import', 'Import session changed.'); delete s.importSession; }); return Response.json({ ok: true }); }
        const prefix = `${project}/imports/${session}/`;
        if (op === 'objects') {
            insist(Number(req.headers.get('content-length') ?? 0) <= 24_000_000, 'request_too_large', 'Object batch exceeds 24 MB.', 413);
            const raw = new Uint8Array(await req.arrayBuffer()); insist(raw.length <= 24_000_000, 'request_too_large', 'Object batch exceeds 24 MB.', 413);
            const descriptors: Descriptor[] = []; let offset = 0;
            while (offset < raw.length) {
                insist(offset + 44 <= raw.length && descriptors.length < 128, 'invalid_batch', 'Invalid or oversized Git object batch.', 400);
                const oid = new TextDecoder().decode(raw.subarray(offset, offset + 40)); const size = new DataView(raw.buffer, raw.byteOffset + offset + 40, 4).getUint32(0);
                offset += 44; insist(size > 0 && offset + size <= raw.length && /^[a-f0-9]{40}$/.test(oid), 'invalid_batch', 'Malformed object frame.', 400);
                const compressed = raw.subarray(offset, offset + size); offset += size;
                const decoded = decodeObject(compressed), validated = await object(decoded.type, decoded.body);
                insist(validated.oid === oid, 'hash_mismatch', 'Git object hash verification failed.', 400);
                const refs = references(decoded.type, decoded.body);
                await bucket.put(git.key(oid), compressed); descriptors.push({ oid, type: decoded.type, refs });
            }
            insist(descriptors.length, 'invalid_batch', 'Empty object batch.', 400);
            const hash = await object('blob', raw);
            await bucket.put(prefix + hash.oid, JSON.stringify(descriptors));
            return Response.json({ batch: hash.oid, objects: descriptors.length });
        }
        insist(op === 'finish', 'invalid_operation', 'Unknown import operation.', 400);
        const input = await req.json() as { head: string; refs: Record<string, string> };
        insist(input.refs && typeof input.refs === 'object' && !Array.isArray(input.refs) && Object.keys(input.refs).length <= 1000, 'invalid_refs', 'Supply at most 1,000 branch/tag refs.', 400);
        const objects = new Map<string, Descriptor>(); let cursor: string | undefined;
        do {
            const batch = await bucket.list({ prefix, cursor });
            for (const entry of batch.objects) {
                const data = await bucket.get(entry.key); insist(data, 'batch_missing', 'Import batch is missing.');
                for (const d of JSON.parse(await data.text()) as Descriptor[]) objects.set(d.oid, d);
                insist(objects.size <= 50000, 'import_capacity', 'Imports support at most 50,000 Git objects.', 413);
            }
            cursor = batch.truncated ? batch.cursor : undefined;
        } while (cursor);
        insist(objects.get(input.head)?.type === 'commit', 'head_missing', 'Upload the selected HEAD commit first.', 400);
        for (const d of objects.values()) for (const target of d.refs) insist(objects.has(target), 'incomplete_history', `Referenced object ${target} was not uploaded. Shallow repositories must be unshallowed before importing.`, 400);
        for (const [ref, oid] of Object.entries(input.refs)) {
            insist(/^refs\/(heads|tags)\//.test(ref) && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.includes('//') && !ref.endsWith('/') && ref.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock')), 'invalid_ref', 'Invalid Git branch or tag name.', 400);
            insist(objects.has(oid) && (!ref.startsWith('refs/heads/') || objects.get(oid)?.type === 'commit'), 'ref_missing', 'A valid ref target was not uploaded.', 400);
        }
        await git.files(input.head);
        const data = await git.read(input.head), commit = new TextDecoder().decode(data.body);
        const refs = { ...input.refs };
        if (refs['refs/heads/main'] && refs['refs/heads/main'] !== input.head) {
            let alias = 'refs/heads/imported/main', suffix = 2;
            while (refs[alias]) alias = `refs/heads/imported/main-${suffix++}`;
            refs[alias] = refs['refs/heads/main'];
        }
        const imported = { session, head: input.head, refs, objectCount: objects.size, at: Date.now() };
        await mutate(project, s => {
            assertSyncWritable(s);
            insist(s.importSession?.id === session && !s.journeys.length && !s.imported, 'import_changed', 'Repository changed during import.');
            s.head = input.head; s.revisions = { [input.head]: { parent: /^parent ([a-f0-9]{40})$/m.exec(commit)?.[1], message: commit.split('\n\n').slice(1).join('\n\n').trim(), actor: user.name, at: imported.at } };
            s.imported = imported; delete s.importSession; emit(s, 'repository.imported', user.id, { revision: input.head, objects: objects.size, refs: Object.keys(input.refs).length });
        });
        return Response.json({ head: input.head, imported });
    } catch (e) { const p = e as ProtocolError; return Response.json({ error: p.message, code: p.code }, { status: p.status ?? 400 }); }
}
