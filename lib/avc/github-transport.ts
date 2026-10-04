import { deflateSync, inflateSync } from 'node:zlib';
import { concatenate, object, parseTree } from './git.ts';
import { insist, ProtocolError } from './core.ts';
import { branchName } from './sync.ts';

// No clone, checkout, archive, recursive-tree request, or repository-sized pack.
// Every operation transfers a single object with a hard response budget.
const LIMIT = 8_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export type GitHubTarget = { owner: string; repo: string };
export function githubTarget(remote: string): GitHubTarget {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
    insist(match && !['.', '..'].includes(match[1]) && !['.', '..'].includes(match[2]), 'invalid_remote', 'Cloud sync requires an HTTPS github.com repository URL without credentials.', 400);
    return { owner: match[1], repo: match[2] };
}
export async function boundedBytes(response: Response, limit = LIMIT): Promise<Uint8Array> {
    insist(response.body, 'github_response', 'GitHub returned an empty response.', 502);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.length;
            insist(size <= limit, 'sync_capacity', 'A GitHub object or protocol response exceeds the 8 MB cloud transfer limit.', 413);
            chunks.push(chunk.value);
        }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
    return concatenate(...chunks);
}
export function packet(text: string) {
    const bytes = encoder.encode(text); return concatenate(encoder.encode((bytes.length + 4).toString(16).padStart(4, '0')), bytes);
}
async function digest(bytes: Uint8Array) { return new Uint8Array(await crypto.subtle.digest('SHA-1', Uint8Array.from(bytes))); }
function equal(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, i) => value === b[i]); }
export async function oneObjectPack(type: 'commit' | 'tree' | 'blob', body: Uint8Array) {
    insist(body.length < LIMIT, 'sync_capacity', 'Git object exceeds the cloud transfer limit.', 413);
    let size = body.length;
    const header = [(type === 'commit' ? 1 : type === 'tree' ? 2 : 3) << 4 | size & 15]; size >>>= 4;
    if (size) header[0] |= 128;
    while (size) { const part = size & 127; size >>>= 7; header.push(part | (size ? 128 : 0)); }
    const pack = concatenate(encoder.encode('PACK'), new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1]), new Uint8Array(header), deflateSync(body));
    return concatenate(pack, await digest(pack));
}
export async function readCommitPack(response: Uint8Array, expected: string): Promise<Uint8Array> {
    // We request no sideband/delta capabilities, tree:0 and depth 1. Parse only
    // the negotiated shallow/NAK packets, never scan for an arbitrary PACK marker.
    let offset = 0;
    while (decoder.decode(response.subarray(offset, offset + 4)) !== 'PACK') {
        const prefix = decoder.decode(response.subarray(offset, offset + 4));
        insist(/^[a-f0-9]{4}$/.test(prefix), 'git_protocol', 'Malformed GitHub Git protocol response.', 502);
        const size = parseInt(prefix, 16); offset += 4;
        if (size === 0) continue;
        insist(size >= 4 && offset + size - 4 <= response.length, 'git_protocol', 'Truncated GitHub Git protocol response.', 502);
        const line = decoder.decode(response.subarray(offset, offset + size - 4)); offset += size - 4;
        insist(line === 'NAK\n' || /^shallow [a-f0-9]{40}\n?$/.test(line), 'git_protocol', 'GitHub did not provide a single shallow commit.', 502);
    }
    const pack = response.subarray(offset);
    insist(pack.length >= 33 && new DataView(pack.buffer, pack.byteOffset).getUint32(4) === 2 && new DataView(pack.buffer, pack.byteOffset).getUint32(8) === 1, 'git_protocol', 'GitHub returned an unsupported multi-object pack.', 502);
    insist(equal(await digest(pack.subarray(0, -20)), pack.subarray(-20)), 'git_protocol', 'GitHub pack checksum mismatch.', 502);
    let pos = 12, byte = pack[pos++], size = byte & 15, shift = 4;
    insist((byte >> 4 & 7) === 1, 'git_protocol', 'GitHub returned a delta or non-commit object instead of one raw commit.', 502);
    while (byte & 128) { insist(pos < pack.length - 20 && shift <= 25, 'git_protocol', 'Invalid Git object size.', 502); byte = pack[pos++]; size += (byte & 127) * 2 ** shift; shift += 7; }
    insist(size < LIMIT, 'sync_capacity', 'Commit exceeds cloud transfer capacity.', 413);
    const compressed = pack.subarray(pos, -20), result: unknown = inflateSync(compressed, { maxOutputLength: LIMIT, info: true });
    // node:zlib supports info:true at runtime; the installed Node type package
    // omits its return overload. Validate the shape instead of hiding a cast.
    insist(result !== null && typeof result === 'object' && 'buffer' in result && result.buffer instanceof Uint8Array && 'engine' in result && result.engine !== null && typeof result.engine === 'object' && 'bytesWritten' in result.engine && typeof result.engine.bytesWritten === 'number', 'git_protocol', 'Git inflater did not return consumption metadata.', 502);
    const body = result.buffer, engine = result.engine;
    insist(body instanceof Uint8Array && engine !== null && typeof engine === 'object' && 'bytesWritten' in engine, 'git_protocol', 'Invalid inflater result.', 502);
    insist(body.length === size && engine.bytesWritten === compressed.length, 'git_protocol', 'Truncated or trailing Git pack data.', 502);
    insist((await object('commit', body)).oid === expected, 'git_protocol', 'GitHub commit bytes do not match their SHA-1.', 502);
    return body;
}
export class GitHubTransport {
    private api: string; private git: string; private token: string; private send: typeof fetch; private execution?: AbortSignal;
    constructor(target: GitHubTarget, token: string, send: typeof fetch = fetch, execution?: AbortSignal) {
        this.token = token; this.send = send.bind(globalThis); this.execution = execution;
        this.api = `https://api.github.com/repos/${target.owner}/${target.repo}`;
        this.git = `https://github.com/${target.owner}/${target.repo}.git`;
    }
    private async request(url: string, init: RequestInit = {}, protocol = false) {
        this.execution?.throwIfAborted();
        const timeout = AbortSignal.timeout(20_000);
        const response = await this.send(url, { ...init, redirect: 'manual', signal: this.execution ? AbortSignal.any([this.execution, timeout]) : timeout, headers: {
            ...(this.token ? { Authorization: protocol ? `Basic ${btoa(`x-access-token:${this.token}`)}` : `Bearer ${this.token}` } : {}),
            'User-Agent': 'Journey-cloud-sync', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...init.headers,
        } });
        if (!response.ok) {
            if (response.status === 409 && url.startsWith(this.api + '/git/ref/heads/')) {
                let value: unknown;
                try { value = JSON.parse(decoder.decode(await boundedBytes(response, 65_536))); } catch { value = null; }
                if (value !== null && typeof value === 'object' && 'message' in value && value.message === 'Git Repository is empty.') throw new ProtocolError('github_empty_repo', 'GitHub repository is empty.', 409);
                throw new ProtocolError('github_request', 'GitHub could not read this branch (409).', 502);
            }
            const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
            const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000, retry = Number(response.headers.get('retry-after'));
            const retryAt = Math.max(Date.now() + 300_000, Number.isFinite(reset) ? reset : 0, Number.isFinite(retry) ? Date.now() + retry * 1000 : 0);
            await response.body?.cancel();
            throw new ProtocolError(limited ? 'github_rate_limit' : response.status === 401 || response.status === 403 ? 'github_auth' : 'github_request', `GitHub request failed (${response.status}). Check repository permissions or retry later.`, response.status === 404 ? 404 : 502, limited ? { retryAt } : undefined);
        }
        return response;
    }
    private async json(path: string, body?: unknown): Promise<Record<string, unknown>> {
        const response = await this.request(this.api + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const value: unknown = JSON.parse(decoder.decode(await boundedBytes(response)));
        insist(value && typeof value === 'object' && !Array.isArray(value), 'github_response', 'Invalid GitHub object response.', 502);
        return value as Record<string, unknown>;
    }
    async head(branch: string): Promise<string | null> {
        try {
            const ref = await this.json(`/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
            const value = ref.object as { sha?: unknown; type?: unknown };
            insist(value?.type === 'commit' && typeof value.sha === 'string' && /^[a-f0-9]{40}$/.test(value.sha), 'github_response', 'Remote branch has no valid commit.', 502);
            return value.sha;
        } catch (error) { if (error instanceof ProtocolError && (error.status === 404 || error.code === 'github_empty_repo')) return null; throw error; }
    }
    async has(hash: string, type: 'commit' | 'tree' | 'blob') {
        insist(/^[a-f0-9]{40}$/.test(hash), 'invalid_revision', 'Invalid Git object ID.', 400);
        try { await (await this.request(`${this.api}/git/${type === 'commit' ? 'commits' : type === 'tree' ? 'trees' : 'blobs'}/${hash}`, { method: 'HEAD' })).body?.cancel(); return true; }
        catch (error) { if (error instanceof ProtocolError && error.status === 404) return false; throw error; }
    }
    async authorizeRepository() {
        const repository = await this.json('');
        insist(typeof repository.id === 'number' && typeof repository.full_name === 'string', 'github_auth', 'GitHub repository access could not be verified.', 403);
    }
    async read(hash: string, type: 'commit' | 'tree' | 'blob'): Promise<Uint8Array> {
        insist(/^[a-f0-9]{40}$/.test(hash), 'invalid_revision', 'Invalid Git object ID.', 400);
        if (type === 'commit') {
            const advertised = await boundedBytes(await this.request(this.git + '/info/refs?service=git-upload-pack', {}, true), 2_000_000);
            insist(decoder.decode(advertised).includes('filter'), 'git_protocol', 'GitHub does not support filtered single-commit transfer.', 502);
            const body = concatenate(packet(`want ${hash} filter\n`), packet('deepen 1\n'), packet('filter tree:0\n'), encoder.encode('0000'), packet('done\n'));
            const response = await this.request(this.git + '/git-upload-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-upload-pack-request' }, body }, true);
            return readCommitPack(await boundedBytes(response), hash);
        }
        let body: Uint8Array;
        if (type === 'blob') {
            const response = await this.request(this.api + `/git/blobs/${hash}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
            body = await boundedBytes(response);
        } else {
            const value = await this.json(`/git/trees/${hash}`);
            insist(value.truncated === false && Array.isArray(value.tree) && value.tree.length <= 50_000, 'sync_capacity', 'GitHub tree is truncated or exceeds cloud transfer capacity.', 413);
            const chunks: Uint8Array[] = [];
            for (const entry of value.tree as { path: string; mode: string; sha: string }[]) {
                insist(typeof entry.path === 'string' && !entry.path.includes('/') && /^[a-f0-9]{40}$/.test(entry.sha) && ['040000', '100644', '100755', '120000', '160000'].includes(entry.mode), 'github_response', 'Invalid GitHub tree entry.', 502);
                chunks.push(concatenate(encoder.encode(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')));
            }
            body = concatenate(...chunks); parseTree(body);
        }
        insist((await object(type, body)).oid === hash, 'git_protocol', 'GitHub object bytes do not match their SHA-1.', 502);
        return body;
    }
    async write(hash: string, type: 'tree' | 'blob', body: Uint8Array) {
        insist(body.length < LIMIT, 'sync_capacity', 'Git object exceeds the 8 MB cloud transfer limit.', 413);
        insist((await object(type, body)).oid === hash, 'invalid_object', 'Outgoing Git object has an invalid SHA-1.', 400);
        const result = type === 'blob' ? await this.json('/git/blobs', { encoding: 'base64', content: Buffer.from(body).toString('base64') }) : await this.json('/git/trees', {
            tree: parseTree(body).map(entry => ({ path: entry.name, mode: entry.mode === '40000' ? '040000' : entry.mode, type: entry.mode === '40000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob', sha: entry.oid })),
        });
        insist(result.sha === hash, 'git_protocol', 'GitHub changed an outgoing object. No branch was updated.', 502);
    }
    async push(ref: string, old: string | null, next: string, commit?: Uint8Array) {
        insist(ref.startsWith('refs/heads/'), 'invalid_ref', 'Sync can update only branch refs.', 400);
        branchName(ref.slice('refs/heads/'.length));
        insist(/^[a-f0-9]{40}$/.test(next) && (old === null || /^[a-f0-9]{40}$/.test(old)), 'invalid_ref', 'Invalid sync ref update.', 400);
        if (commit) insist((await object('commit', commit)).oid === next, 'invalid_object', 'Invalid outgoing commit SHA-1.', 400);
        // receive-pack compares the exact old OID atomically. Never use a REST
        // force update (or an ancestry-only fast-forward race) for branch writes.
        const pack = commit ? await oneObjectPack('commit', commit) : concatenate(encoder.encode('PACK'), new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0]));
        const empty = commit ? pack : concatenate(pack, await digest(pack));
        await this.sendPack(ref, old, next, empty);
    }
    async initializeTransfer(ref: string, beforePush: () => Promise<void>) {
        insist(ref.startsWith('refs/heads/journey-transfer/'), 'invalid_ref', 'Initialization can create only a Journey transfer ref.', 400);
        branchName(ref.slice('refs/heads/'.length));
        const tree = await object('tree', new Uint8Array());
        const body = encoder.encode(`tree ${tree.oid}\nauthor Journey <sync@journey.local> 0 +0000\ncommitter Journey <sync@journey.local> 0 +0000\n\nInitialize bounded Journey object transfer\n`);
        const commit = await object('commit', body), current = await this.head(ref.slice('refs/heads/'.length));
        insist(current === null || current === commit.oid, 'conflict_ref_exists', 'The transfer initialization ref already contains another revision.', 409);
        if (current === null) {
            const treePack = await oneObjectPack('tree', new Uint8Array()), commitPack = await oneObjectPack('commit', body);
            const pack = concatenate(encoder.encode('PACK'), new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2]), treePack.subarray(12, -20), commitPack.subarray(12, -20));
            await beforePush();
            await this.sendPack(ref, null, commit.oid, concatenate(pack, await digest(pack)));
        }
        return commit.oid;
    }
    private async sendPack(ref: string, old: string | null, next: string, pack: Uint8Array) {
        const body = concatenate(packet(`${old ?? '0'.repeat(40)} ${next} ${ref}\0report-status\n`), encoder.encode('0000'), pack);
        const response = await this.request(this.git + '/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body }, true);
        const result = decoder.decode(await boundedBytes(response, 1_000_000));
        insist(result.includes('unpack ok\n') && result.includes(`ok ${ref}\n`) && !result.includes(`ng ${ref} `), 'github_push', 'GitHub refused the exact-head update. Recheck the remote head and retry safely.', 409);
    }
}
