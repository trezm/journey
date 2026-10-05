'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, GitBranch, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { GitSyncWarning } from '@/components/git-sync-warning';
import type { SyncState } from '@/lib/avc/sync';
import type { Provider, ProviderRepository } from '@/lib/avc/oauth';
import styles from './git-sync-settings.module.css';

type Snapshot = { head: string; sync?: SyncState; user: { agent: boolean } };
type Account = { configured: boolean; connection: { provider: Provider; username: string } | null; repositories?: ProviderRepository[]; nextPage?: number | null };
type Configuration = { remote: string; branch: string; enabled: boolean };
const configuration = (sync?: SyncState): Configuration => ({ remote: sync?.remote ?? '', branch: sync?.branch ?? 'main', enabled: sync?.enabled ?? false });
async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? 'Could not load Git sync.');
    return data;
}

export function GitSyncSettings({ project }: { project: string }) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [draft, setDraft] = useState<Configuration | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [token, setToken] = useState('');
    const [accounts, setAccounts] = useState<Partial<Record<Provider, Account>>>({});
    const [provider, setProvider] = useState<Provider>('github');
    const [repositories, setRepositories] = useState<ProviderRepository[]>([]);
    const [nextPage, setNextPage] = useState<number | null>(null);
    const [accountBusy, setAccountBusy] = useState(false);
    const selectedProvider: Provider = draft?.remote.startsWith('https://gitlab.com/') ? 'gitlab' : 'github';
    const linked = !!accounts[selectedProvider]?.connection;
    useEffect(() => {
        let active = true;
        void Promise.all((['github', 'gitlab'] as const).map(async p => {
            const account = await request<Account>(`/api/oauth/${p}?project=${encodeURIComponent(project)}`);
            if (active) setAccounts(value => ({ ...value, [p]: account }));
        })).catch(e => { if (active) setError((e as Error).message); });
        void Promise.resolve().then(() => {
            if (!active) return;
            const result = new URLSearchParams(window.location.search).get('oauth');
            if (result === 'connected') setNotice('Provider account connected. Select a repository and save Git sync.');
            if (result === 'failed') setError('The provider connection was not completed. Connect the account again.');
        });
        return () => { active = false; };
    }, [project]);
    async function connect(p: Provider) {
        setAccountBusy(true); setError('');
        try {
            const value = await request<{ url: string }>(`/api/oauth/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
            window.location.assign(value.url);
        } catch (e) { setError((e as Error).message); setAccountBusy(false); }
    }
    async function listRepositories(p: Provider, page = 1) {
        setAccountBusy(true); setError(''); setProvider(p);
        try {
            const value = await request<Account>(`/api/oauth/${p}?project=${encodeURIComponent(project)}&repos=1&page=${page}`);
            setRepositories(previous => page === 1 ? value.repositories ?? [] : [...previous, ...value.repositories ?? []]); setNextPage(value.nextPage ?? null);
        } catch (e) { setError((e as Error).message); }
        finally { setAccountBusy(false); }
    }
    const [now, setNow] = useState(() => Date.now());
    const initialized = useRef(false);
    useEffect(() => {
        let active = true, pending = false;
        const controller = new AbortController();
        async function load() {
            if (pending) return;
            pending = true;
            try {
                const data = await request<Snapshot>(`/api/sync?project=${encodeURIComponent(project)}`, { signal: controller.signal });
                if (!active) return;
                setSnapshot(data);
                if (!initialized.current) { setDraft(configuration(data.sync)); initialized.current = true; }
            } catch (e) { if (active) setError((e as Error).message); }
            finally { pending = false; if (active) { setLoading(false); setNow(Date.now()); } }
        }
        void load();
        const timer = setInterval(() => { void load(); }, 5000);
        return () => { active = false; controller.abort(); clearInterval(timer); };
    }, [project]);
    async function refresh() {
        const data = await request<Snapshot>(`/api/sync?project=${encodeURIComponent(project)}`);
        setSnapshot(data); setNow(Date.now());
        return data;
    }
    const sync = snapshot?.sync;
    const editable = !!snapshot && !snapshot.user.agent;
    const saved = configuration(sync);
    const changed = !!draft && (draft.remote !== saved.remote || draft.branch !== saved.branch || draft.enabled !== saved.enabled || !!token);
    const locked = !!sync?.run;
    const lastActivity = sync ? Math.max(sync.lastCheckedAt ?? 0, sync.updatedAt) : 0;
    const stale = !!lastActivity && now - lastActivity > 900000;
    const status = !sync?.enabled ? 'Disabled' : sync.status === 'conflict' ? 'Conflict — paused' : sync.status === 'error' ? 'Needs attention' : sync.run?.phase === 'resolving' ? 'Applying resolution' : sync.status === 'running' ? 'Synchronizing' : !sync.lastSyncedHead ? sync.hosted ? 'Waiting for hosted sync' : 'Waiting for existing bridge' : sync.lastSyncedHead === snapshot?.head ? 'Up to date at last sync' : 'Waiting to publish';
    function change(update: Partial<Configuration>) { setDraft(value => value ? { ...value, ...update } : value); setNotice(''); }
    async function save(event: React.FormEvent) {
        event.preventDefault();
        if (!draft || !editable || locked || busy) return;
        setBusy(true); setError(''); setNotice('');
        try {
            await request('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, action: 'configure', hosted: linked || !!token || !sync || !!sync.hosted || draft.remote.trim() !== saved.remote, ...draft, oauth: linked && !token, token: token || undefined, remote: draft.remote.trim(), branch: draft.branch.trim() }) });
            const data = await refresh(); setDraft(configuration(data.sync));
            setToken(''); setNotice(data.sync?.hosted ? 'Hosted Git sync settings saved. Cloudflare checks this repository automatically.' : 'Existing Git bridge settings saved. Connect a provider account to migrate to hosted sync.');
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    }
    async function recover(action: 'reconnect' | 'cancel') {
        setBusy(true); setError('');
        try {
            await request('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, action, ...(action === 'reconnect' ? { token: token || undefined, oauth: linked && !token } : {}) }) });
            setToken(''); const data = await refresh(); setDraft(configuration(data.sync));
            setNotice(action === 'reconnect' ? 'Provider credentials reconnected. Preserved sync work resumes automatically.' : 'Hosted sync disabled. Preserved history remains available; repository writes can resume.');
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    }
    return <section className={styles.section} aria-labelledby="git-sync-heading">
        <div className={styles.card}>
            <header className={styles.heading}><GitBranch size={21}/><div><h2 id="git-sync-heading">Git publishing & sync</h2><p>Connect one Git branch to publish integrated work and bring remote changes into Journey.</p></div></header>
            {loading ? <p className={styles.loading} role="status">Loading Git sync…</p> : <>
                {snapshot && draft && <>
                    <div className={styles.status}><div><span className={styles.statusLabel}>SYNC STATUS</span><strong>{status}</strong></div><div className={styles.lastSync}>{lastActivity ? <>{sync?.lastCheckedAt === lastActivity ? 'Last checked' : 'Last activity'} <time dateTime={new Date(lastActivity).toISOString()}>{new Date(lastActivity).toLocaleString()}</time></> : 'No hosted sync activity recorded'}{sync?.enabled && stale && <span>No recent activity. Check Cloudflare scheduling and provider permissions.</span>}</div></div>
                    {editable && <div className={styles.accounts}>
                        <h3>Connected accounts</h3><p>Connect GitHub or GitLab to select a personal repository. Provider credentials stay on the server.</p>
                        <div className={styles.accountButtons}>{(['github', 'gitlab'] as const).map(p => <div key={p}>
                            <strong>{p === 'github' ? 'GitHub' : 'GitLab'}</strong>
                            <span>{accounts[p]?.connection ? `Connected as ${accounts[p]!.connection!.username}` : accounts[p]?.configured === false ? 'OAuth is not configured for this deployment' : 'Not connected'}</span>
                            <Button type="button" variant="outline" disabled={busy || accountBusy || accounts[p]?.configured !== true} onClick={() => { void connect(p); }}>{accounts[p]?.connection ? 'Reconnect account' : `Connect ${p === 'github' ? 'GitHub' : 'GitLab'}`}</Button>
                            {accounts[p]?.connection && <Button type="button" variant="outline" disabled={busy || accountBusy || locked} onClick={() => { void listRepositories(p); }}>Choose repository</Button>}
                        </div>)}</div>
                        {repositories.length > 0 && <label htmlFor="provider-repository">{provider === 'github' ? 'GitHub' : 'GitLab'} repository<select id="provider-repository" disabled={busy || accountBusy || locked} value={repositories.some(repo => repo.remote === draft.remote) ? draft.remote : ''} onChange={event => { const repo = repositories.find(value => value.remote === event.target.value); if (repo) change({ remote: repo.remote, branch: repo.branch }); }}><option value="">Select a repository</option>{repositories.map(repo => <option key={repo.id} value={repo.remote}>{repo.name} ({repo.private ? 'private' : 'public'})</option>)}</select></label>}
                        {nextPage && <Button type="button" variant="outline" disabled={accountBusy} onClick={() => { void listRepositories(provider, nextPage); }}>Load more repositories</Button>}
                        {accountBusy && <p role="status">Loading provider…</p>}
                    </div>}
                    <form onSubmit={save}>
                        {!editable && <p className={styles.ownerOnly}>Only the repository owner can configure Git sync.</p>}
                        {sync && !sync.hosted && <p className={styles.ownerOnly}>This repository uses an existing Git bridge. Connect your provider account to migrate to hosted synchronization.</p>}
                        {locked && <p className={styles.ownerOnly}>Configuration is locked while this sync is active. Finish recovery before changing the remote or disabling sync.</p>}
                        <div className={styles.fields}>
                            <label htmlFor="sync-remote">Git remote URL<input id="sync-remote" type="text" value={draft.remote} onChange={event => change({ remote: event.target.value })} placeholder="https://github.com/team/repository.git" disabled={!editable || busy || locked} required autoComplete="off" spellCheck={false} aria-describedby="sync-remote-help"/><span id="sync-remote-help">Use a github.com or gitlab.com HTTPS repository URL, or select a repository above. Authentication is stored encrypted in Cloudflare.</span></label>
                            <label htmlFor="sync-branch">Remote branch<input id="sync-branch" type="text" value={draft.branch} onChange={event => change({ branch: event.target.value })} placeholder="main" disabled={!editable || busy || locked} required autoComplete="off" spellCheck={false} aria-describedby="sync-branch-help"/><span id="sync-branch-help">Journey’s main syncs with this branch. Your deployment service can watch it for changes.</span></label>
                            <label htmlFor="sync-token">GitHub access token (optional fallback)<input id="sync-token" type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Leave blank to retain an existing token" disabled={!editable || busy} autoComplete="new-password"/><span>Use a fine-grained token restricted to this repository with Contents read and write permissions. Add Workflows write permission when changing workflow files. The token is never returned to your browser.</span></label>
                            <div className={styles.toggle}><div><label htmlFor="sync-enabled">Enable two-way sync</label><p id="sync-enabled-help">Cloudflare polls every five minutes and incrementally transfers missing Git objects. Divergent heads pause for an explicit merge; repository writes remain paused until recovery.</p></div><Switch id="sync-enabled" checked={draft.enabled} onCheckedChange={value => change({ enabled: value })} disabled={!editable || busy || locked} aria-describedby="sync-enabled-help"/></div>
                        </div>
                        {sync?.hosted && editable && <div className={styles.downloads}><Button type="button" variant="outline" disabled={busy || (!token && !linked)} onClick={() => { void recover('reconnect'); }}>Reconnect sync credentials</Button>{locked && <Button type="button" variant="outline" disabled={busy} onClick={() => { void recover('cancel'); }}>Disable sync & release pause</Button>}</div>}
                        <footer className={styles.footer}><p>{changed ? 'You have unsaved changes.' : sync ? 'Settings are up to date.' : 'Add a remote to get started.'}</p><div><Button type="button" variant="outline" disabled={!changed || busy || locked} onClick={() => { setDraft(saved); setNotice(''); }}>Discard changes</Button><Button type="submit" disabled={!editable || !changed || busy || locked || !draft.remote.trim() || !draft.branch.trim()}>{busy ? 'Saving…' : 'Save Git sync'}</Button></div></footer>
                    </form>
                </>}
            </>}
        </div>
        {error && <div className={styles.error} role="alert"><AlertTriangle size={17}/><span>{error}</span><Button type="button" variant="ghost" size="sm" onClick={() => { setError(''); void refresh().catch(e => setError((e as Error).message)); }}><RefreshCw size={14}/>Retry</Button></div>}
        {notice && <div className={styles.notice} role="status"><CheckCircle2 size={17}/>{notice}</div>}
        {snapshot && <GitSyncWarning key={sync?.run?.id ?? 'idle'} project={project} sync={sync} editable={editable} onRefresh={refresh}/>}
        <div className={styles.runner}><h3>Hosted in Cloudflare</h3><p>Automatic two-way sync runs in Cloudflare. No downloaded runner or local process is required. Git objects transfer individually through the existing R2 object store; no repository is cloned or checked out.</p><p className={styles.small}>GitLab uses a Journey object-transfer branch to keep each upload bounded. Large initial history transfers resume through bounded queue continuations. Each object must fit the 8 MB transfer limit. Divergent history is preserved on a conflict branch and requires an owner-selected resolution.</p></div>
    </section>;
}
