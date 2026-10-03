'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, GitBranch, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { GitSyncWarning } from '@/components/git-sync-warning';
import type { SyncState } from '@/lib/avc/sync';
import styles from './git-sync-settings.module.css';

type Snapshot = { head: string; sync?: SyncState; user: { agent: boolean } };
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
    const changed = !!draft && (draft.remote !== saved.remote || draft.branch !== saved.branch || draft.enabled !== saved.enabled);
    const locked = !!sync?.run;
    const lastActivity = sync ? Math.max(sync.lastCheckedAt ?? 0, sync.updatedAt) : 0;
    const stale = !!lastActivity && now - lastActivity > 120000;
    const status = !sync?.enabled ? 'Disabled' : sync.status === 'conflict' ? 'Conflict — paused' : sync.status === 'error' ? 'Needs attention' : sync.run?.phase === 'resolving' ? 'Applying resolution' : sync.status === 'running' ? 'Synchronizing' : !sync.lastSyncedHead ? 'Waiting for runner' : sync.lastSyncedHead === snapshot?.head ? 'Up to date at last sync' : 'Waiting to publish';
    function change(update: Partial<Configuration>) { setDraft(value => value ? { ...value, ...update } : value); setNotice(''); }
    async function save(event: React.FormEvent) {
        event.preventDefault();
        if (!draft || !editable || locked || busy) return;
        setBusy(true); setError(''); setNotice('');
        try {
            await request('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, action: 'configure', ...draft, remote: draft.remote.trim(), branch: draft.branch.trim() }) });
            const data = await refresh(); setDraft(configuration(data.sync));
            setNotice('Git sync settings saved. Keep the runner active to synchronize this repository.');
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    }
    async function downloadConnection() {
        setBusy(true); setError(''); setNotice('');
        try {
            const response = await fetch('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
            if (!response.ok) { const data = await response.json() as { error?: string }; throw new Error(data.error ?? 'Connection download failed.'); }
            const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url; link.download = 'journey-connection.json'; link.click(); URL.revokeObjectURL(url);
            setNotice('Connection downloaded. Keep it private and out of Git; it grants access to this repository.');
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    }
    return <section className={styles.section} aria-labelledby="git-sync-heading">
        <div className={styles.card}>
            <header className={styles.heading}><GitBranch size={21}/><div><h2 id="git-sync-heading">Git publishing & sync</h2><p>Connect one Git branch to publish integrated work and bring remote changes into Journey.</p></div></header>
            {loading ? <p className={styles.loading} role="status">Loading Git sync…</p> : <>
                {snapshot && draft && <>
                    <div className={styles.status}><div><span className={styles.statusLabel}>SYNC STATUS</span><strong>{status}</strong></div><div className={styles.lastSync}>{lastActivity ? <>{sync?.lastCheckedAt === lastActivity ? 'Last checked' : 'Last activity'} <time dateTime={new Date(lastActivity).toISOString()}>{new Date(lastActivity).toLocaleString()}</time></> : 'No runner activity recorded'}{sync?.enabled && stale && <span>No recent activity. Check that the runner is still active.</span>}</div></div>
                    <form onSubmit={save}>
                        {!editable && <p className={styles.ownerOnly}>Only the repository owner can configure Git sync.</p>}
                        {locked && <p className={styles.ownerOnly}>Configuration is locked while this sync is active. Finish recovery before changing the remote or disabling sync.</p>}
                        <div className={styles.fields}>
                            <label htmlFor="sync-remote">Git remote URL<input id="sync-remote" type="text" value={draft.remote} onChange={event => change({ remote: event.target.value })} placeholder="https://git.example.com/team/repository.git" disabled={!editable || busy || locked} required autoComplete="off" spellCheck={false} aria-describedby="sync-remote-help"/><span id="sync-remote-help">Use an HTTPS or SSH Git URL without passwords or tokens. The runner uses your local Git credentials.</span></label>
                            <label htmlFor="sync-branch">Remote branch<input id="sync-branch" type="text" value={draft.branch} onChange={event => change({ branch: event.target.value })} placeholder="main" disabled={!editable || busy || locked} required autoComplete="off" spellCheck={false} aria-describedby="sync-branch-help"/><span id="sync-branch-help">Journey’s main syncs with this branch. Your deployment service can watch it for changes.</span></label>
                            <div className={styles.toggle}><div><label htmlFor="sync-enabled">Enable two-way sync</label><p id="sync-enabled-help">Publish after integration and fetch remote updates while the runner is active. Divergent commits are rebased and pushed with a lease; conflicts pause repository writes.</p></div><Switch id="sync-enabled" checked={draft.enabled} onCheckedChange={value => change({ enabled: value })} disabled={!editable || busy || locked} aria-describedby="sync-enabled-help"/></div>
                        </div>
                        <footer className={styles.footer}><p>{changed ? 'You have unsaved changes.' : sync ? 'Settings are up to date.' : 'Add a remote to get started.'}</p><div><Button type="button" variant="outline" disabled={!changed || busy || locked} onClick={() => { setDraft(saved); setNotice(''); }}>Discard changes</Button><Button type="submit" disabled={!editable || !changed || busy || locked || !draft.remote.trim() || !draft.branch.trim()}>{busy ? 'Saving…' : 'Save Git sync'}</Button></div></footer>
                    </form>
                </>}
            </>}
        </div>
        {error && <div className={styles.error} role="alert"><AlertTriangle size={17}/><span>{error}</span><Button type="button" variant="ghost" size="sm" onClick={() => { setError(''); void refresh().catch(e => setError((e as Error).message)); }}><RefreshCw size={14}/>Retry</Button></div>}
        {notice && <div className={styles.notice} role="status"><CheckCircle2 size={17}/>{notice}</div>}
        {snapshot && <GitSyncWarning key={sync?.run?.id ?? 'idle'} project={project} sync={sync} editable={editable} onRefresh={refresh}/>}
        <div className={styles.runner}>
            <h3>Run the Git bridge</h3><p>Sync requires a process running on your computer or server with Node.js 22+ and native Git. Leave it running for automatic publishing and incoming updates. Git authentication stays on that machine.</p>
            <div className={styles.downloads}><Button asChild variant="outline"><a href="/git-sync.mjs" download="git-sync.mjs"><Download size={16}/>Download Git runner</a></Button><Button variant="outline" disabled={!editable || busy || locked} onClick={downloadConnection}><Download size={16}/>Download connection</Button></div>
            <pre><code>node git-sync.mjs --connection journey-connection.json --watch</code></pre>
            <p className={styles.small}>Run in a trusted directory with access to your Git credential helper or SSH key. Keep the connection file private and out of Git. Use <code>--once</code> instead of <code>--watch</code> for a single sync.</p>
            {locked && <p className={styles.small}>Restart an interrupted sync with the same connection file that started it. A new connection cannot take over an active run.</p>}
        </div>
    </section>;
}
