'use client';
import { FileCode2, Folder, GitBranch, RefreshCw } from 'lucide-react';
import { useSourceFile, useSourceTree } from '@/hooks/use-repository';
import { SyntaxSource } from './syntax-code';
import { Button } from './ui/button';

const unavailable = {
    binary: 'This binary file cannot be displayed as text.',
    large: 'This file exceeds the 500 KB source preview limit.',
    symlink: 'This entry is a symbolic link. Clone the repository to inspect its target.',
    submodule: 'This entry is a Git submodule. Clone the repository to inspect it.',
};

export function RepositorySource({ project, revision, chosenPath, onPathChange, onJourney }: {
    project: string; revision?: string; chosenPath: string; onPathChange: (path: string) => void; onJourney?: () => void;
}) {
    // A trailing slash selects a directory; existing file deep links remain valid.
    const directory = chosenPath.slice(0, chosenPath.lastIndexOf('/') + 1);
    const tree = useSourceTree(project, revision, directory.replace(/\/$/, ''));
    const entries = tree.data?.entries ?? [];
    const requested = chosenPath.slice(directory.length);
    const selected = requested || entries.find(entry => entry.name === 'README.md' && entry.mode !== '40000')?.name || '';
    const selectedEntry = entries.find(entry => entry.name === selected);
    const path = selectedEntry && selectedEntry.mode !== '40000' ? directory + selected : '';
    const source = useSourceFile(project, revision, tree.status === 'ready' ? path : '');
    const file = source.data?.file;
    const parts = directory.split('/').filter(Boolean);
    return <section className="code-panel" aria-label="Repository code">
        <div className="editor-toolbar" style={{ flexWrap: 'wrap' }}>
            <div><GitBranch size={16}/><strong>Repository source</strong><span className="mono" title={revision}>{revision?.slice(0, 7) ?? '—'}</span></div>
            {onJourney && <Button variant="outline" onClick={onJourney}>Journey revision</Button>}
        </div>
        <nav aria-label="Source directory" className="editor-toolbar" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            <Button variant="ghost" onClick={() => onPathChange('')}>Repository</Button>
            {parts.map((part, index) => <Button key={index} variant="ghost" onClick={() => onPathChange(parts.slice(0, index + 1).join('/') + '/')}>/ {part}</Button>)}
        </nav>
        {tree.status === 'loading' || tree.status === 'idle' ? <div className="empty-panel compact" role="status">Loading directory…</div> : tree.error ? <div className="empty-panel compact" role="alert"><p>{tree.error}</p><Button onClick={() => void tree.reload()}><RefreshCw/>Try again</Button></div> : <>
            <div className="source-workspace"><nav className="source-tree" aria-label="Source tree"><h3>Files</h3><ul>
                {directory && <li><button onClick={() => onPathChange(parts.slice(0, -1).join('/') + (parts.length > 1 ? '/' : ''))}>.. / Parent directory</button></li>}
                {entries.map(entry => <li key={entry.name}><button aria-current={entry.name === selected ? 'page' : undefined} onClick={() => onPathChange(directory + entry.name + (entry.mode === '40000' ? '/' : ''))}>{entry.mode === '40000' ? <Folder size={14}/> : <FileCode2 size={14}/>}<span>{entry.name}{entry.mode === '40000' ? '/' : ''}</span></button></li>)}
            </ul></nav><div className="source-content"><div className="editor-toolbar"><div className="file-picker" style={{ width: '100%', minWidth: 0 }}><Folder size={17}/><select aria-label="File or directory" value={selectedEntry ? selected : ''} onChange={event => {
                const entry = entries.find(item => item.name === event.target.value);
                if (entry) onPathChange(directory + entry.name + (entry.mode === '40000' ? '/' : ''));
            }} style={{ minWidth: 0 }}><option value="">Choose a file or directory ({entries.length})</option>{entries.map(entry => <option key={entry.name} value={entry.name}>{entry.mode === '40000' ? '📁 ' : ''}{entry.name}{entry.mode === '40000' ? '/' : ''}</option>)}</select></div></div>
            {!entries.length ? <div className="empty-panel compact"><h2>Empty directory</h2><p>This revision has no entries here.</p></div> : requested && !selectedEntry ? <div className="empty-panel compact" role="alert">This path does not exist in this revision. Choose another file above.</div> : !path ? <div className="empty-panel compact"><FileCode2 size={28}/><p>Choose a file to view its source.</p></div> : source.status === 'loading' || source.status === 'idle' ? <div className="empty-panel compact" role="status">Loading {selected}…</div> : source.error ? <div className="empty-panel compact" role="alert"><p>{source.error}</p><Button onClick={() => void source.reload()}><RefreshCw/>Try again</Button></div> : file?.kind === 'text' ? <><div className="editor-context">{path} · read only</div><SyntaxSource path={path} source={file.content} editable={false}/></> : file ? <div className="empty-panel compact"><FileCode2 size={28}/><p>{unavailable[file.kind]}</p><p>This entry remains available in the Git repository.</p></div> : null}</div></div>
        </>}
    </section>;
}
