'use client';
import { useState } from 'react';
import { GitBranch, ArrowLeft, Globe, RefreshCw } from 'lucide-react';
import type { RepositorySummary } from '@/lib/avc/repository-visibility';
import type { State } from '@/lib/avc/core';
import { useRepositoryFiles } from '@/hooks/use-repository';
import { codePath } from '@/lib/repository-code';
import { RepositoryCodePanel } from './repository-code-panel';
import { RepositoryPicker } from './repository-picker';
import { Button } from './ui/button';

export function PublicRepository({ repository, projects, state, onProject, signedIn, onSignIn }: { repository: RepositorySummary; projects: RepositorySummary[]; state: State; onProject: (id: string) => void; signedIn: boolean; onSignIn: () => void }) {
    const [history, setHistory] = useState(''), [chosenPath, setChosenPath] = useState('');
    const revision = history && state.revisions[history] ? history : state.head;
    const snapshot = useRepositoryFiles(repository.id, revision), path = codePath(snapshot.files, chosenPath);
    return <div className="app-shell">
        <aside className="sidebar"><div className="wordmark"><span className="brand-icon"><GitBranch size={21}/></span>Journey</div><div className="workspace-label">PUBLIC REPOSITORIES</div><RepositoryPicker projects={projects} value={repository.id} onValueChange={onProject}/><div className="sidebar-divider"/><p className="small">Public repositories share accepted code and history. Only their owner can manage journeys.</p><button className="sidebar-link" style={{ display: 'flex' }} onClick={() => onProject('')}><ArrowLeft size={16}/>{signedIn ? 'Your workspace' : 'All repositories'}</button>{!signedIn && <Button variant="outline" onClick={onSignIn}>Sign in</Button>}</aside>
        <div className="main-shell"><header className="topbar"><div className="breadcrumb"><Globe size={18}/>{repository.owner.username} / <strong>{repository.name}</strong></div><span className="chip">Public · read only</span></header>
            <main className="workspace"><div className="page-heading"><div><div className="eyebrow">PUBLIC REPOSITORY</div><h1>{repository.name}</h1><p>Owned by {repository.owner.username}. Browse accepted code and revision history.</p></div></div>
                <section className="panel"><label>Accepted revision<select value={revision} onChange={event => setHistory(event.target.value)}>{Object.entries(state.revisions).map(([oid, commit]) => <option key={oid} value={oid}>{oid.slice(0, 7)} · {commit.message}{oid === state.head ? ' · main' : ''}</option>)}</select></label><p className="small">Clone accepted Git history: <code>{typeof window !== 'undefined' ? window.location.origin : ''}/api/git/{repository.id}</code></p></section>
                {snapshot.status === 'ready' && !Object.keys(snapshot.files).length ? <section className="empty-panel"><h2>No browsable text files</h2><p>This revision is empty or contains only binary, symlink, submodule, or large files. Clone the accepted Git history to inspect its contents.</p></section> : <RepositoryCodePanel mode="repository" onModeChange={() => setHistory('')} revision={revision} files={snapshot.files} path={path} onPathChange={setChosenPath} content={snapshot.files[path] ?? ''} onContentChange={() => {}} status={snapshot.status} error={snapshot.error} leases={[]} busy={false} onRetry={() => { void snapshot.reload(); }} onLock={() => {}} onPatch={() => {}}/>}
                {snapshot.status === 'loading' && <span className="small"><RefreshCw size={14}/>Loading accepted code…</span>}
            </main>
        </div>
    </div>;
}
