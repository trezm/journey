'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useWorkspaceRoute } from '@/hooks/use-workspace-route';
import { ArrowLeft, GitBranch, GitMerge, ShieldCheck, UserCheck, Settings, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { GitSyncSettings } from '@/components/git-sync-settings';
import { repositoryPolicy, type State } from '@/lib/avc/core';
import type { RepositorySummary, Visibility } from '@/lib/avc/repository-visibility';
import styles from './settings.module.css';

type Policy = ReturnType<typeof repositoryPolicy>;
type Repository = { state: State; user: { agent: boolean } | null; project: RepositorySummary };
async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? 'Could not load repository settings.');
    return data;
}

export default function RepositorySettings() {
    const { project, hrefFor } = useWorkspaceRoute();
    const [repository, setRepository] = useState<Repository | null>(null);
    const [saved, setSaved] = useState<Policy | null>(null), [draft, setDraft] = useState<Policy | null>(null);
    const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    useEffect(() => {
        let active = true;
        void Promise.resolve().then(async () => {
            if (!active) return;
            const id = project;
            if (!id) { setError('Open settings from a repository workspace.'); setLoading(false); return; }
            setLoading(true); setRepository(null); setSaved(null); setDraft(null); setError(''); setNotice('');
            try {
                const data = await request<Repository>(`/api/avc?project=${encodeURIComponent(id)}`);
                if (!active) return;
                const policy = repositoryPolicy(data.state);
                setRepository(data); setSaved(policy); setDraft(policy);
            } catch (e) { if (active) setError((e as Error).message); }
            finally { if (active) setLoading(false); }
        });
        return () => { active = false; };
    }, [project]);
    const editable = !!repository?.project.permissions.write && !repository?.user?.agent;
    const changed = saved && draft && Object.keys(saved).some(key => saved[key as keyof Policy] !== draft[key as keyof Policy]);
    function change(key: keyof Policy, value: boolean) { setDraft(p => p ? { ...p, [key]: value } : p); setNotice(''); }
    async function save(event: React.FormEvent) {
        event.preventDefault();
        if (!draft || !saved || !editable || saving) return;
        const changes = Object.fromEntries((Object.keys(draft) as (keyof Policy)[]).filter(key => draft[key] !== saved[key]).map(key => [key, draft[key]]));
        if (!Object.keys(changes).length) return;
        setSaving(true); setError(''); setNotice('');
        try {
            const data = await request<{ result: { policy: Policy } }>('/api/avc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'policy', project, requestId: crypto.randomUUID(), ...changes }) });
            const policy = data.result.policy as Policy;
            setSaved(policy); setDraft(policy); setNotice('Repository settings saved.');
        } catch (e) { setError((e as Error).message); }
        finally { setSaving(false); }
    }
    async function saveVisibility(value: Visibility) {
        if (!editable || !repository || saving) return;
        setSaving(true); setError(''); setNotice('');
        try {
            await request('/api/avc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'visibility', project, visibility: value }) });
            setRepository({ ...repository, project: { ...repository.project, visibility: value } });
            setNotice(`Repository is now ${value}.`);
        } catch (e) { setError((e as Error).message); }
        finally { setSaving(false); }
    }
    return <main className={styles.page}>
        <header className={styles.header}><Link href="/" className={styles.brand}><span><GitBranch size={22}/></span>Journey</Link>{project ? <a href={hrefFor({ journey: '', tab: 'code', mode: 'repository', path: '' })} className={styles.back}><ArrowLeft size={16}/>Back to workspace</a> : <span className={styles.back} aria-disabled="true"><ArrowLeft size={16}/>Back to workspace</span>}</header>
        <div className={styles.content}>
            <div className={styles.heading}><div className={styles.eyebrow}>{repository?.state.name ?? 'REPOSITORY'}</div><h1><Settings size={25}/>Repository settings</h1><p>Choose how your workers merge changes, how your coordinator reviews them, and how Git remotes stay in sync.</p></div>
            {loading && <p role="status" className={styles.loading}>Loading settings…</p>}
            {error && <div role="alert" className={styles.error}><AlertTriangle size={18}/><span>{error}</span></div>}
            {notice && <div role="status" className={styles.success}><CheckCircle2 size={18}/>{notice}</div>}
            {!loading && repository && !editable && <p className={styles.ownerOnly}>Only the repository owner can access settings. Open repository code to browse this public repository.</p>}
            {!loading && editable && repository && <section className={styles.card}><div className={styles.cardHeading}><ShieldCheck size={20}/><div><h2>Repository visibility</h2><p>Owned by {repository.project.owner.username}. Repositories belong to one personal account.</p></div></div><div className={styles.row}><div className={styles.copy}><label htmlFor="repository-visibility">Visibility</label><p id="repository-visibility-help">Private repositories are visible only to you and your repository agents. Public repositories let anyone read accepted code and Git history, including original commit author metadata. Journeys, reviews, recordings, and credentials stay private. Making a repository private cannot recall copies already downloaded.</p></div><select id="repository-visibility" aria-describedby="repository-visibility-help" value={repository.project.visibility} disabled={saving} onChange={event => { void saveVisibility(event.target.value as Visibility); }}><option value="private">Private</option><option value="public">Public</option></select></div></section>}
            {!loading && editable && draft && <form onSubmit={save} className={styles.card}>
                <div className={styles.cardHeading}><ShieldCheck size={20}/><div><h2>Repository permissions</h2><p>These settings apply to this repository and all of its journeys.</p></div></div>
                {!editable && <p className={styles.ownerOnly}>Only the repository owner can change these settings.</p>}
                <div className={styles.row}><div className={styles.icon}><GitMerge size={20}/></div><div className={styles.copy}><label htmlFor="worker-merge">Allow workers to merge</label><p id="worker-merge-help">Workers can merge their own submitted journeys after required approval. Current locks and reconciliation are still required. When off, the owner merges completed journeys.</p></div><Switch id="worker-merge" aria-describedby="worker-merge-help" checked={draft.allowWorkerMerge} onCheckedChange={v => change('allowWorkerMerge', v)} disabled={!editable || saving}/></div>
                <div className={styles.row}><div className={styles.icon}><UserCheck size={20}/></div><div className={styles.copy}><label htmlFor="coordinator-approval">Allow the coordinator to approve</label><p id="coordinator-approval-help">A coordinator can review and approve other workers’ submitted journeys. It cannot approve its own work. Turning this off cancels its existing approvals; those journeys need a new approval before owner integration or when worker approval is required.</p></div><Switch id="coordinator-approval" aria-describedby="coordinator-approval-help" checked={draft.allowCoordinatorApproval} onCheckedChange={v => change('allowCoordinatorApproval', v)} disabled={!editable || saving}/></div>
                <div className={styles.row}><div className={styles.icon}><ShieldCheck size={20}/></div><div className={styles.copy}><label htmlFor="require-approval">Require approval for worker merges</label><p id="require-approval-help">Workers need approval of the exact current revision by the owner or an allowed coordinator. The Integrate button always requires approval. New patches or compatibility declarations require another review.</p></div><Switch id="require-approval" aria-describedby="require-approval-help" checked={draft.requireApproval} onCheckedChange={v => change('requireApproval', v)} disabled={!editable || saving}/></div>
                <footer className={styles.footer}><p>{changed ? 'You have unsaved changes.' : 'Settings are up to date.'}</p><div><Button type="button" variant="outline" disabled={!changed || saving} onClick={() => { setDraft(saved); setNotice(''); }}>Discard changes</Button><Button type="submit" disabled={!editable || !changed || saving}>{saving ? 'Saving…' : 'Save settings'}</Button></div></footer>
            </form>}
            {!loading && editable && repository && project && <GitSyncSettings key={project} project={project}/>}
            {!loading && !repository && <Link href="/" className={styles.recovery}>Open your workspace to sign in and select a repository.</Link>}
        </div>
    </main>;
}
