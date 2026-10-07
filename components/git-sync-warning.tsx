'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, GitBranch, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SyncState } from '@/lib/avc/sync';
import styles from './git-sync-warning.module.css';

type Props = { project: string; sync?: SyncState; editable: boolean; onRefresh: () => Promise<unknown> };

function Reference({ label, value, href }: { label: string; value: string; href?: string }) {
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState(false);
    async function copy() {
        try { await navigator.clipboard.writeText(value); setCopied(true); setCopyError(false); }
        catch { setCopyError(true); }
    }
    return <div className={styles.reference}>
        <dt>{label}</dt>
        <dd>{href ? <a href={href} target="_blank" rel="noreferrer"><code>{value}</code><ExternalLink size={13}/></a> : <code>{value}</code>}
            <button type="button" title={`Copy ${label.toLowerCase()}`} aria-label={`Copy ${label.toLowerCase()}`} onClick={copy}>{copied ? <CheckCircle2 size={14}/> : <Copy size={14}/>}</button>
        </dd>
        {copyError && <p role="status">Select the value to copy it.</p>}
    </div>;
}

export function GitSyncWarning({ project, sync, editable, onRefresh }: Props) {
    const [head, setHead] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const run = sync?.run;
    if (!sync || (!run && sync.status !== 'error' && !(sync.enabled && sync.status === 'running'))) return null;
    const conflict = !!run && (run.phase === 'conflict' || !!run.conflicts?.length);
    const resolving = run?.phase === 'resolving';
    const active = sync.enabled && sync.status === 'running' && !conflict;
    const progress = sync.hosted ? sync.progress : null;
    const phase = progress ? {
        import: 'Importing Git history',
        'remote-ancestry': 'Checking remote history',
        'journey-ancestry': 'Checking Journey history',
        export: 'Uploading Git history',
        publish: 'Publishing synchronized revision',
    }[progress.phase] : resolving ? 'Applying your Git resolution' : run?.phase === 'publishing' ? 'Publishing synchronized revision' : 'Preparing Git sync';
    async function resume(event: React.FormEvent) {
        event.preventDefault();
        if (!run || !editable || busy || !/^[a-f0-9]{40}$/i.test(head.trim())) return;
        setBusy(true); setError(''); setNotice('');
        try {
            const response = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, action: 'resolve', runId: run.id, head: head.trim().toLowerCase() }) });
            const data = await response.json() as { error?: string };
            if (!response.ok) throw new Error(data.error ?? 'Could not resume Git sync.');
            setNotice(sync.hosted ? 'Resolution requested. Cloudflare will verify and import this exact remote commit.' : 'Resolution requested. Keep the configured runner active to verify and import this exact commit.');
            try { await onRefresh(); } catch { setError('Resolution was requested, but the status could not refresh. Refresh this page to check progress.'); }
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    }
    return <section className={`${styles.warning} ${!conflict && sync.status !== 'error' ? styles.progress : ''}`} aria-label="Git sync status">
        <div className={styles.heading} role={conflict || sync.status === 'error' ? 'alert' : 'status'}>
            {conflict || sync.status === 'error' ? <AlertTriangle size={21}/> : <RefreshCw size={20} className={active ? styles.spinning : undefined} aria-hidden="true"/>}
            <div><h2>{sync.status === 'error' && !conflict ? 'Git sync needs attention' : active && sync.hosted ? phase : resolving ? 'Applying your Git resolution' : conflict ? 'Git conflict: repository paused' : run ? 'Repository paused for Git sync' : 'Git sync needs attention'}</h2>
                <p>{run ? 'Writes to this repository are paused. You can still inspect and export its history.' : active ? 'Synchronization is running. Progress refreshes automatically.' : 'Synchronization could not finish. Check the configured sync service and credentials; both heads are preserved.'}</p>
            </div>
        </div>
        {sync.error && <p className={styles.error}>{sync.error}</p>}
        {progress && <div className={styles.transfer}>
            <p className={styles.phase}>{active ? 'Current phase' : 'Saved progress'}: <strong>{phase}</strong></p>
            <dl className={styles.counters} aria-live="polite" aria-atomic="true">
                <div><dt>Processed in this phase</dt><dd>{progress.objects.toLocaleString('en-US')}</dd></div>
                <div><dt>Currently queued</dt><dd>{progress.pending.toLocaleString('en-US')}</dd></div>
            </dl>
            <p className={styles.detail}>Counts cover the current phase and reset when the phase changes. The queue can grow as more history is discovered, so the total is not known in advance.</p>
            {active && <p className={styles.detail}>Progress refreshes automatically. The repository’s visible revision updates when synchronization finishes.</p>}
            {!active && <p className={styles.detail}>These are the last saved counts; synchronization needs attention before it can finish.</p>}
        </div>}
        {run && active && !resolving && !progress && <p className={styles.detail}>Automatic synchronization will finish {run.phase === 'publishing' ? 'publishing the synchronized commits' : 'checking and preparing the remote changes'}. {sync.hosted ? 'Interrupted work resumes automatically.' : 'Restart an interrupted run with its original connection file.'} Sync resumes after this operation completes.</p>}
        {run && (conflict || resolving) && <>
            <dl className={styles.references}>
                <Reference label="Preserved Journey head" value={run.journeyHead} href={`/api/avc?project=${encodeURIComponent(project)}&revision=${encodeURIComponent(run.journeyHead)}`}/>
                <Reference label={`Remote ${sync.branch} at detection`} value={run.remoteHead ?? 'Branch did not exist'}/>
                <Reference label="Git remote" value={sync.remote}/>
                <Reference label="Conflict branch" value={run.conflictBranch}/>
                {run.resolutionHead && <Reference label="Requested resolution" value={run.resolutionHead}/>} 
            </dl>
            <div className={styles.publication}>
                {run.conflictPublished ? <CheckCircle2 size={17}/> : <AlertTriangle size={17}/>}
                <p><strong>{run.conflictPublished ? 'Conflict branch published.' : 'Conflict branch publication is not confirmed.'}</strong> {run.conflictPublished ? 'The remote branch preserves the original Journey head for manual recovery.' : 'Retry the configured sync service to publish this branch. The Journey head remains available above.'}</p>
            </div>
            {run.conflictPublishError && <p className={styles.error}>Branch publication failed: {run.conflictPublishError}</p>}
            {!!run.conflicts?.length && <div className={styles.files}><h3>Conflicting files</h3><ul>{run.conflicts.map(path => <li key={path}><code>{path}</code></li>)}</ul></div>}
            <>
                <div className={styles.recovery}><h3><GitBranch size={16}/>Resolve through Git</h3><ol>
                    <li>In a local clone of the remote, fetch <code>{sync.branch}</code> and the conflict branch above.</li>
                    <li>Rebase or merge the preserved Journey commits with the latest <code>{sync.branch}</code>, resolve conflicts, and push the result to <code>{sync.branch}</code>.</li>
                    <li>Copy the full 40-character commit SHA now at the remote branch and enter it below. Resume will adopt that exact commit into Journey.</li>
                </ol><p>After sync completes, reconcile active journeys and reacquire invalidated locks before continuing.</p></div>
                {editable ? <form onSubmit={resume} className={styles.resume}>
                    <label htmlFor={`sync-resolution-${project}`}>Resolved remote commit SHA<input id={`sync-resolution-${project}`} value={head} onChange={event => { setHead(event.target.value); setNotice(''); }} placeholder="40-character Git commit SHA" pattern="[a-fA-F0-9]{40}" minLength={40} maxLength={40} required autoComplete="off" spellCheck={false} disabled={busy} aria-describedby={`sync-resolution-help-${project}`}/></label>
                    <p id={`sync-resolution-help-${project}`}>This replaces Journey’s canonical head with your resolution. Your recorded journeys and original history remain available.</p>
                    <Button type="submit" disabled={busy || !/^[a-f0-9]{40}$/i.test(head.trim())}><RefreshCw size={16}/>{busy ? 'Requesting resume…' : resolving ? 'Update resolution & resume' : 'Resume sync'}</Button>
                </form> : <p className={styles.detail}>The repository owner must confirm the resolved commit and resume sync.</p>}
            </>
            {resolving && <p className={styles.detail}>Synchronization confirms the requested commit is still the remote branch head before applying it. If the remote moved, enter its new resolved SHA above. Repository writes remain paused until synchronization finishes.</p>}
        </>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {notice && <p className={styles.detail} role="status">{notice}</p>}
    </section>;
}
