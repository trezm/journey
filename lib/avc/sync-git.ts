import { GitStore, decodeObject, object, parseTree, references } from './git.ts';
import { insist, ProtocolError, type State } from './core.ts';
import { oid, type SyncTree } from './sync.ts';

export const SYNC_OBJECT_LIMIT = 50_000;
const MAX_CLOSURE_BYTES = 300_000_000;

/** Bound payloads while reading, even when Content-Length is absent or false. */
export async function syncBody(req: Request, limit: number): Promise<Uint8Array> {
    const declared = req.headers.get('content-length');
    insist(!declared || (Number.isFinite(Number(declared)) && Number(declared) >= 0 && Number(declared) <= limit), 'request_too_large', 'Sync request exceeds its size limit.', 413);
    insist(req.body, 'invalid_request', 'A request body is required.', 400);
    const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); insist(false, 'request_too_large', 'Sync request exceeds its size limit.', 413); }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    chunks.length = 0;
    return result;
}

export async function uploadSyncObjects(git: GitStore, bucket: R2Bucket, raw: Uint8Array) {
    let offset = 0, count = 0;
    while (offset < raw.length) {
        insist(offset + 44 <= raw.length && count < 128, 'invalid_batch', 'Invalid or oversized Git object batch.', 400);
        const hash = oid(new TextDecoder().decode(raw.subarray(offset, offset + 40)));
        const size = new DataView(raw.buffer, raw.byteOffset + offset + 40, 4).getUint32(0); offset += 44;
        insist(size > 0 && offset + size <= raw.length, 'invalid_batch', 'Malformed Git object frame.', 400);
        const compressed = raw.subarray(offset, offset + size); offset += size;
        let decoded: ReturnType<typeof decodeObject>;
        try { decoded = decodeObject(compressed); }
        catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError('invalid_object', 'Malformed or oversized compressed Git object.', 400); }
        const validated = await object(decoded.type, decoded.body);
        insist(validated.oid === hash, 'hash_mismatch', 'Git object hash verification failed.', 400);
        references(decoded.type, decoded.body);
        await bucket.put(git.key(hash), compressed);
        count++;
    }
    insist(count > 0, 'invalid_batch', 'Empty Git object batch.', 400);
    return { objects: count };
}

/** Only accepted or previously verified commit roots are closure cut points. */
export function trustedSyncHeads(s: State) {
    return new Set([s.head, ...Object.keys(s.revisions), ...Object.values(s.imported?.refs ?? {}), ...Object.values(s.sync?.backupRefs ?? {})]);
}
export async function verifySyncClosure(git: GitStore, head: string, trusted: Set<string>) {
    const root = await git.read(head); insist(root.type === 'commit', 'invalid_revision', 'The sync head must be a Git commit.', 400);
    type Reference = { hash: string; type?: string };
    const stack: Reference[] = [{ hash: head, type: 'commit' }], seen = new Map<string, string>(); let bytes = 0;
    while (stack.length) {
        const { hash, type } = stack.pop()!;
        if (seen.has(hash)) { insist(!type || seen.get(hash) === type, 'invalid_object_type', 'Git history references an object with the wrong type.', 400); continue; }
        insist(seen.size < SYNC_OBJECT_LIMIT, 'sync_capacity', 'A sync transfer exceeds 50,000 Git objects.', 413);
        // Root commits are checked above. Existing complete histories need no repeated blob reads.
        const decoded = hash === head ? root : await git.read(hash);
        insist(!type || decoded.type === type, 'invalid_object_type', 'Git history references an object with the wrong type.', 400);
        seen.set(hash, decoded.type);
        if (trusted.has(hash)) continue;
        bytes += decoded.body.length;
        insist(bytes <= MAX_CLOSURE_BYTES, 'sync_capacity', 'A sync transfer exceeds 300 MB of uncompressed Git objects.', 413);
        if (decoded.type === 'tree') {
            for (const entry of parseTree(decoded.body)) if (entry.mode !== '160000') stack.push({ hash: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob' });
        } else if (decoded.type === 'commit' || decoded.type === 'tag') {
            references(decoded.type, decoded.body);
            const header = new TextDecoder().decode(decoded.body).split('\n\n')[0];
            if (decoded.type === 'commit') for (const target of header.matchAll(/^(tree|parent) ([a-f0-9]{40})$/gm)) stack.push({ hash: target[2], type: target[1] === 'tree' ? 'tree' : 'commit' });
            else {
                const target = /^object ([a-f0-9]{40})$/m.exec(header)?.[1], targetType = /^type (blob|tree|commit|tag)$/m.exec(header)?.[1];
                insist(target && targetType, 'invalid_tag', 'Git tag has no valid target type.', 400);
                stack.push({ hash: target, type: targetType });
            }
        }
        insist(stack.length <= SYNC_OBJECT_LIMIT * 4, 'sync_capacity', 'Git object reference fan-out exceeds the sync limit.', 413);
    }
    // This checks tree object types and bounded paths, including already-stored descendants.
    await git.entries(head);
}
export async function syncAncestor(git: GitStore, ancestor: string, head: string) {
    const stack = [head], seen = new Set<string>();
    while (stack.length) {
        const hash = stack.pop()!;
        if (hash === ancestor) return true;
        if (seen.has(hash)) continue;
        seen.add(hash);
        insist(seen.size <= SYNC_OBJECT_LIMIT, 'sync_capacity', 'Git ancestry exceeds 50,000 commits.', 413);
        const commit = await git.read(hash); insist(commit.type === 'commit', 'invalid_commit', 'Git history references a non-commit object.', 400);
        const header = new TextDecoder().decode(commit.body).split('\n\n')[0];
        for (const parent of header.matchAll(/^parent ([a-f0-9]{40})$/gm)) if (!seen.has(parent[1])) stack.push(parent[1]);
    }
    return false;
}
export async function syncTree(git: GitStore, head: string): Promise<SyncTree> { return { entries: await git.entries(head), files: await git.files(head) }; }
export async function syncCommitMeta(git: GitStore, head: string): Promise<State['revisions'][string]> {
    const commit = await git.read(head); insist(commit.type === 'commit', 'invalid_commit', 'Expected a Git commit.', 400);
    const text = new TextDecoder().decode(commit.body), split = text.indexOf('\n\n'), header = split < 0 ? text : text.slice(0, split);
    const author = /^author (.*?) <[^\n]*> (\d+) [+-]\d{4}$/m.exec(header);
    return { parent: /^parent ([a-f0-9]{40})$/m.exec(header)?.[1], message: (split < 0 ? '' : text.slice(split + 2)).trim().slice(0, 4000), actor: author?.[1]?.slice(0, 200) || 'Git author', at: author ? Math.min(Number(author[2]) * 1000, 253402300799999) : Date.now() };
}
