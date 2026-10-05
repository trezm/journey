import { GitHubTransport, boundedBytes, oneObjectPack, packet, readObjectPack } from './github-transport.ts';
import { concatenate, object, parseTree } from './git.ts';
import { insist, ProtocolError } from './core.ts';
import { branchName } from './sync.ts';
const encoder = new TextEncoder(), decoder = new TextDecoder();
export function gitlabTarget(remote: string) {
    const match = /^https:\/\/gitlab\.com\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+?)(?:\.git)?\/?$/.exec(remote);
    insist(match && match[1].split('/').every(part => part !== '.' && part !== '..') && match[1].length <= 500, 'invalid_remote', 'Use an HTTPS gitlab.com repository URL without credentials.', 400);
    return match[1].replace(/\.git$/, '');
}
export class GitLabTransport extends GitHubTransport {
    private carrier: string;
    private beforePush: () => Promise<void>;
    constructor(target: string, token: string, send: typeof fetch = fetch, execution?: AbortSignal, carrier = 'journey-objects/transfer', beforePush: () => Promise<void> = async () => undefined) {
        super({ owner: '', repo: '' }, token, send, execution);
        this.git = `https://gitlab.com/${target}.git`; this.api = `https://gitlab.com/api/v4/projects/${encodeURIComponent(target)}`;
        this.carrier = branchName(carrier); this.beforePush = beforePush;
    }
    protected override async request(url: string, init: RequestInit = {}, protocol = false) {
        this.execution?.throwIfAborted();
        const timeout = AbortSignal.timeout(20_000);
        const response = await this.send(url, { ...init, redirect: 'manual', signal: this.execution ? AbortSignal.any([this.execution, timeout]) : timeout, headers: {
            Authorization: protocol ? `Basic ${btoa(`oauth2:${this.token}`)}` : `Bearer ${this.token}`, 'User-Agent': 'Journey-cloud-sync', Accept: 'application/json', ...init.headers,
        } });
        if (!response.ok) {
            const limited = response.status === 429, retry = Number(response.headers.get('retry-after'));
            await response.body?.cancel();
            throw new ProtocolError(limited ? 'gitlab_rate_limit' : response.status === 401 || response.status === 403 ? 'gitlab_auth' : 'gitlab_request', `GitLab request failed (${response.status}). Check repository permissions or retry later.`, response.status === 404 ? 404 : 502, limited ? { retryAt: Date.now() + Math.max(300_000, Number.isFinite(retry) ? retry * 1000 : 0) } : undefined);
        }
        return response;
    }
    private async get(path: string): Promise<Record<string, unknown>> {
        const value: unknown = JSON.parse(decoder.decode(await boundedBytes(await this.request(this.api + path))));
        insist(value && typeof value === 'object' && !Array.isArray(value), 'gitlab_response', 'Invalid GitLab response.', 502);
        return value as Record<string, unknown>;
    }
    override async authorizeRepository() {
        const value = await this.get(''), permissions = value.permissions as { project_access?: { access_level?: number }; group_access?: { access_level?: number } } | undefined;
        const namespace = value.namespace as { kind?: string } | undefined;
        insist(typeof value.id === 'number' && namespace?.kind === 'user' && value.archived !== true && Math.max(permissions?.project_access?.access_level ?? 0, permissions?.group_access?.access_level ?? 0) >= 30, 'gitlab_auth', 'Choose a writable personal GitLab repository.', 403);
    }
    override async head(branch: string): Promise<string | null> {
        branchName(branch);
        try {
            const value = await this.get(`/repository/branches/${encodeURIComponent(branch)}`), commit = value.commit as { id?: string } | undefined;
            insist(commit?.id && /^[a-f0-9]{40}$/.test(commit.id), 'gitlab_response', 'Remote branch has no valid commit.', 502);
            return commit.id;
        } catch (error) { if (error instanceof ProtocolError && error.status === 404) return null; throw error; }
    }
    override async has(hash: string, type: 'commit' | 'tree' | 'blob') {
        insist(/^[a-f0-9]{40}$/.test(hash), 'invalid_revision', 'Invalid Git object ID.', 400);
        // GitLab has no Git database write API. Replay missing commit closure
        // through bounded carrier commits; duplicate blobs/trees are harmless.
        if (type !== 'commit') return false;
        try { await this.get(`/repository/commits/${hash}`); return true; }
        catch (error) { if (error instanceof ProtocolError && error.status === 404) return false; throw error; }
    }
    override async read(hash: string, type: 'commit' | 'tree' | 'blob'): Promise<Uint8Array> {
        insist(/^[a-f0-9]{40}$/.test(hash), 'invalid_revision', 'Invalid Git object ID.', 400);
        if (type === 'blob') {
            const body = await boundedBytes(await this.request(`${this.api}/repository/blobs/${hash}/raw`));
            insist((await object(type, body)).oid === hash, 'git_protocol', 'GitLab blob does not match its SHA-1.', 502); return body;
        }
        const advertised = decoder.decode(await boundedBytes(await this.request(this.git + '/info/refs?service=git-upload-pack', {}, true), 2_000_000));
        insist(advertised.includes('filter'), 'git_protocol', 'GitLab does not support bounded object transfer.', 502);
        // Explicitly wanted objects survive tree:0 filtering. Trees therefore
        // transfer without children; commit transfer also limits parent history.
        const body = concatenate(packet(`want ${hash} filter\n`), ...(type === 'commit' ? [packet('deepen 1\n')] : []), packet('filter tree:0\n'), encoder.encode('0000'), packet('done\n'));
        const bytes = await boundedBytes(await this.request(this.git + '/git-upload-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-upload-pack-request' }, body }, true));
        return readObjectPack(bytes, hash, type);
    }
    override async write(hash: string, type: 'tree' | 'blob', body: Uint8Array) {
        insist((await object(type, body)).oid === hash && body.length < 8_000_000, 'invalid_object', 'Invalid or oversized outgoing Git object.', 400);
        if (type === 'tree') parseTree(body);
        // Each scratch-branch commit makes the transferred object reachable.
        // Keeping its previous head as a parent preserves earlier objects across
        // queue continuations and server GC, without changing the target branch.
        const old = await this.head(this.carrier), parts = [await oneObjectPack(type, body)];
        let tree = hash;
        if (type === 'blob') {
            const entry = concatenate(encoder.encode('100644 object\0'), Buffer.from(hash, 'hex'));
            tree = (await object('tree', entry)).oid; parts.push(await oneObjectPack('tree', entry));
        }
        const commitBody = encoder.encode(`tree ${tree}\n${old ? `parent ${old}\n` : ''}author Journey <sync@journey.local> 0 +0000\ncommitter Journey <sync@journey.local> 0 +0000\n\nTransfer ${hash}\n`);
        const commit = await object('commit', commitBody); parts.push(await oneObjectPack('commit', commitBody));
        const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, parts.length);
        const payload = concatenate(encoder.encode('PACK'), new Uint8Array([0, 0, 0, 2]), count, ...parts.map(part => part.subarray(12, -20)));
        const pack = concatenate(payload, new Uint8Array(await crypto.subtle.digest('SHA-1', Uint8Array.from(payload))));
        await this.beforePush(); await this.sendPack(`refs/heads/${this.carrier}`, old, commit.oid, pack);
    }
}
