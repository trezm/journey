'use client';
import { Code2, FileCode2, GitBranch, GitCommitHorizontal, LockKeyhole, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SyntaxSource } from '@/components/syntax-code';
import type { Files, Journey, Lease } from '@/lib/avc/core';
import type { CodeMode, Resource } from '@/lib/repository-code';

type Props = {
    mode: CodeMode;
    onModeChange: (mode: CodeMode) => void;
    revision?: string;
    journey?: Journey;
    files: Files;
    path: string;
    onPathChange: (path: string) => void;
    content: string;
    onContentChange: (content: string) => void;
    status: Resource<unknown>['status'];
    error: string;
    leases: Lease[];
    busy: boolean;
    onRetry: () => void;
    onLock: () => void;
    onPatch: () => void;
};

export function RepositoryCodePanel(props: Props) {
    const { mode, revision, journey, files, path, content, status, error, leases, busy } = props;
    const paths = Object.keys(files).sort();
    const editing = mode === 'journey' && !!journey;
    const closed = journey?.status === 'integrated' || journey?.status === 'abandoned';
    const ready = status === 'ready';
    const reserved = leases.filter(lease => lease.path === path);
    return <section className="code-panel" aria-label="Repository code">
        <div className="editor-toolbar" style={{ flexWrap: 'wrap' }}>
            <div role="group" aria-label="Code revision" style={{ flexWrap: 'wrap' }}>
                <Button variant={mode === 'repository' ? 'default' : 'outline'} aria-pressed={mode === 'repository'} onClick={() => props.onModeChange('repository')}><GitBranch />Repository · main</Button>
                {journey && <Button variant={editing ? 'default' : 'outline'} aria-pressed={editing} onClick={() => props.onModeChange('journey')}>Journey revision</Button>}
                <span className="mono" title={revision}>{revision?.slice(0, 7) ?? '—'}</span>
            </div>
            {editing && <div style={{ flexWrap: 'wrap' }}>
                <Button variant="outline" disabled={!ready || !path || closed || !journey.changesets.length || busy} onClick={props.onLock}><LockKeyhole />Acquire lock</Button>
                <Button disabled={!ready || !path || closed || !reserved.length || busy || content === files[path]} onClick={props.onPatch}><GitCommitHorizontal />Record patch</Button>
            </div>}
        </div>
        {status === 'loading' || status === 'idle' ? <div className="empty-panel compact" role="status"><RefreshCw size={28}/><h2>Loading repository code…</h2><p>Opening this revision’s files.</p></div> : error ? <div className="empty-panel compact" role="alert"><FileCode2 size={28}/><h2>Code could not be loaded</h2><p>{error}</p><Button variant="outline" onClick={props.onRetry}><RefreshCw />Try again</Button></div> : !paths.length ? <div className="empty-panel compact"><FileCode2 size={28}/><h2>No browsable text files</h2><p>This revision is empty or contains only binary, symlink, submodule, or large files. Import your repository from Connect & import, or inspect those files in your local Git checkout.</p></div> : <>
            <div className="editor-toolbar"><div className="file-picker" style={{ minWidth: 0, width: '100%' }}><FileCode2 size={17}/><select value={path} aria-label="File" onChange={event => props.onPathChange(event.target.value)} style={{ minWidth: 0 }}>{paths.map(file => <option key={file} value={file}>{file}</option>)}</select></div></div>
            <div className="editor-context">{editing ? reserved.length ? <><LockKeyhole size={14}/>{reserved.map(lease => lease.whole ? 'Whole file' : `Lines ${lease.start}–${lease.end}`).join(', ')} reserved</> : <><Code2 size={14}/>Journey revision · a valid lock is required to record changes</> : <><GitBranch size={14}/>Current repository code · read only{journey && ' · choose Journey revision to edit'}</>}</div>
            <SyntaxSource path={path} source={content} editable={editing && !closed} onChange={props.onContentChange}/>
        </>}
    </section>;
}
