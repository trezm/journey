'use client';
import { useId, useMemo, useRef, useState } from 'react';
import { Activity, ArrowRight, ChevronLeft, ChevronRight, FileCode2, GitBranch, List, LockKeyhole, Minus, Network, Pause, Play, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useLiveLockMap } from '@/hooks/use-live-lock-map';
import type { LiveChangeset, LiveFile, LiveRegion } from '@/lib/avc/live';
import { compareLiveFiles, lockGraph, radialLockLayout, graphSpoke } from '@/lib/live-map';
import { homeRoute, workspaceHref } from '@/lib/workspace-route';
import styles from './live-lock-map.module.css';

const PAGE_SIZE = 20;
const scope = (region: LiveRegion) => region.start === region.end ? `Line ${region.start}` : `Lines ${region.start}–${region.end}`;
const fileName = (path: string) => path.split('/').at(-1) ?? path;
const directory = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '/';
const short = (text: string, length = 39) => text.length > length ? text.slice(0, length - 1) + '…' : text;
const activityDate = (at: number) => at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No recorded activity';
type Selection = { file?: string; changeset?: string; start?: number; end?: number };

function Pager({ page, count, onChange }: { page: number; count: number; onChange: (page: number) => void }) {
    if (count <= PAGE_SIZE) return null;
    return <nav className={styles.pager} aria-label="Live map pages"><button aria-label="Previous files" disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft size={16}/></button><span>{page * PAGE_SIZE + 1}–{Math.min(count, (page + 1) * PAGE_SIZE)} of {count} files</span><button aria-label="Next files" disabled={(page + 1) * PAGE_SIZE >= count} onClick={() => onChange(page + 1)}><ChevronRight size={16}/></button></nav>;
}

function LockGraph({ files, changesets, selection, onSelect }: { files: LiveFile[]; changesets: LiveChangeset[]; selection: Selection; onSelect: (selection: Selection) => void }) {
    const [zoom, setZoom] = useState(1);
    const graph = useMemo(() => lockGraph(files, changesets), [files, changesets]);
    const layout = useMemo(() => radialLockLayout(graph), [graph]);
    const edgePath = (edge: typeof graph.edges[number]) => graphSpoke(layout.changesets.get(edge.changeset)!, layout.files.get(edge.file)!);
    const selectedEdge = (edge: typeof graph.edges[number]) => edge.file === selection.file || edge.changeset === selection.changeset;
    const activate = (event: React.KeyboardEvent<SVGGElement>, next: Selection) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(next); }
    };
    if (!graph.files.length) return <div className={styles.empty}><Network size={30}/><h3>No held locks to connect</h3><p>Files appear here when an open changeset holds a lock. Try clearing your search or check the ranked list for waiting requests.</p></div>;
    return <>
        <div className={styles.graphToolbar}><span>{graph.changesets.length} open changesets · {graph.files.length} locked files on this page</span><div className={styles.controls}><button aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Minus size={14}/></button><button aria-label="Reset graph zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button aria-label="Zoom in" disabled={zoom >= 1.5} onClick={() => setZoom(value => Math.min(1.5, value + .25))}><Plus size={14}/></button></div></div>
        <div className={styles.graphViewport} tabIndex={0} aria-label="Lock ownership graph; scroll to explore, use Tab to select nodes">
            <svg className={styles.graph} width={layout.width * zoom} height={layout.height * zoom} style={{ width: `${zoom * 100}%`, minWidth: Math.max(Math.min(960, layout.width), layout.width * .8) * zoom, maxWidth: layout.width * zoom, height: 'auto' }} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Open changesets and the files they hold">
                {[...graph.edges].sort((a, b) => Number(selectedEdge(a)) - Number(selectedEdge(b))).map(edge => <path key={`${edge.changeset}:${edge.file}`} data-map-edge={`${edge.changeset}:${edge.file}`} d={edgePath(edge)} className={`${styles.edge} ${edge.conflictCount ? styles.conflictEdge : ''} ${selectedEdge(edge) ? styles.selectedEdge : ''}`}><title>{`${edge.lockCount} held ${edge.lockCount === 1 ? 'lock' : 'locks'}${edge.conflictCount ? `, ${edge.conflictCount} conflicting` : ''}`}</title></path>)}
                {graph.edges.slice(0, 60).map((edge, index) => <path key={`pulse:${edge.changeset}:${edge.file}`} aria-hidden="true" className={styles.edgePulse} pathLength="100" style={{ animationDelay: `${index % 7 * -.6}s` }} d={edgePath(edge)}/>)}
                {graph.changesets.map(change => {
                    const selected = selection.changeset === change.id;
                    const card = layout.changesets.get(change.id)!;
                    const related = graph.edges.some(edge => edge.changeset === change.id && edge.file === selection.file);
                    return <g key={change.id} data-map-changeset={change.id} className={`${styles.graphNode} ${styles.changesetNode} ${selected || related ? styles.selectedNode : ''}`} transform={`translate(${card.x - card.width / 2} ${card.y - card.height / 2})`} role="button" tabIndex={0} aria-pressed={selected} aria-label={`${change.description}, ${change.title}, ${change.lockCount} held locks`} onClick={() => onSelect({ changeset: change.id })} onKeyDown={event => activate(event, { changeset: change.id })}>
                        <title>{`${change.description} · ${change.title} · ${change.status} · ${change.lockCount} held locks`}</title><rect width={card.width} height={card.height} rx="8"/><text x="14" y="22">{short(change.description, 31)}</text><text className={styles.nodeDetail} x="14" y="42">{short(change.title, 22)} · {change.status === 'review' ? 'Review' : 'Working'}</text>
                    </g>;
                })}
                {graph.files.map(file => {
                    const selected = selection.file === file.path;
                    const card = layout.files.get(file.path)!;
                    const related = graph.edges.some(edge => edge.file === file.path && edge.changeset === selection.changeset);
                    return <g key={file.path} data-map-file={file.path} className={`${styles.graphNode} ${file.conflictCount ? styles.conflictNode : ''} ${selected || related ? styles.selectedNode : ''}`} transform={`translate(${card.x - card.width / 2} ${card.y - card.height / 2})`} role="button" tabIndex={0} aria-pressed={selected} aria-label={`${file.path}, ${file.lockCount} held locks, ${file.conflictCount} conflicting locks`} onClick={() => onSelect({ file: file.path })} onKeyDown={event => activate(event, { file: file.path })}>
                        <title>{`${file.path} · ${file.lockCount} held locks · ${file.conflictCount} conflicting locks`}</title><rect width={card.width} height={card.height} rx="8"/><text x="14" y="22">{short(file.path, 32)}</text><text className={styles.nodeDetail} x="14" y="42">{file.lockCount} held · {file.conflictCount} conflicting · {file.waitingCount} waiting</text>
                    </g>;
                })}
            </svg>
        </div>
        <p className={styles.graphNote}>Changesets sit in the center, with locked files around them. Connections show held locks only. Select a node to highlight its connections; use Tab and Enter with a keyboard. Scroll to explore the graph.</p>
    </>;
}

export function LiveLockMap({ project }: { project: string }) {
    const live = useLiveLockMap(project);
    const [view, setView] = useState<'list' | 'graph'>('list');
    const [query, setQuery] = useState('');
    const [activityOnly, setActivityOnly] = useState(true);
    const [page, setPage] = useState(0);
    const [selection, setSelection] = useState<Selection>({});
    const inspector = useRef<HTMLDivElement>(null);
    const inspectorId = useId();
    const snapshot = live.data;
    function inspect(next: Selection) {
        setSelection(next);
        // Only an explicit selection moves focus; live polling keeps the reader's place.
        requestAnimationFrame(() => {
            inspector.current?.focus({ preventScroll: true });
            inspector.current?.scrollIntoView({ block: 'nearest' });
        });
    }
    const rankedFiles = useMemo(() => [...(snapshot?.files ?? [])].sort(compareLiveFiles), [snapshot]);
    const allGraph = useMemo(() => lockGraph(rankedFiles, snapshot?.changesets ?? []), [rankedFiles, snapshot]);
    const filteredFiles = useMemo(() => (view === 'graph' ? allGraph.files : rankedFiles).filter(file => file.path.toLowerCase().includes(query.trim().toLowerCase()) && (view === 'graph' || !activityOnly || file.lockCount > 0 || file.waitingCount > 0)), [view, allGraph, rankedFiles, query, activityOnly]);
    const safePage = Math.min(page, Math.max(0, Math.ceil(filteredFiles.length / PAGE_SIZE) - 1));
    const files = useMemo(() => filteredFiles.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE), [filteredFiles, safePage]);
    const selectedFile = snapshot?.files.find(file => file.path === selection.file);
    const selectedChange = snapshot?.changesets.find(change => change.id === selection.changeset);
    const selectedRegion = selectedFile?.regions.find(region => region.start === selection.start && region.end === selection.end);
    const connectedChangesets = selectedFile ? (snapshot?.changesets ?? []).filter(change => change.paths.includes(selectedFile.path)) : [];
    const lockedPaths = selectedChange ? rankedFiles.filter(file => file.heldLocks.some(lock => lock.changeset === selectedChange.id)).map(file => file.path) : [];
    const chooseFile = (file: LiveFile, region?: LiveRegion) => inspect({ file: file.path, start: region?.start, end: region?.end });
    const chooseView = (next: 'list' | 'graph') => { setView(next); setPage(0); };
    function revealFile(path: string) {
        setQuery(''); setActivityOnly(false);
        const candidates = view === 'graph' && allGraph.files.some(file => file.path === path) ? allGraph.files : rankedFiles;
        if (candidates === rankedFiles) setView('list');
        setPage(Math.max(0, Math.floor(candidates.findIndex(file => file.path === path) / PAGE_SIZE))); inspect({ file: path });
    }
    const fileHref = (path: string) => workspaceHref({ ...homeRoute, project, path });
    const changesetHref = (change: LiveChangeset) => workspaceHref({ ...homeRoute, project, journey: change.journey, tab: 'changesets', mode: 'journey' });
    const refreshTime = live.receivedAt ? new Date(live.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const conflictCount = rankedFiles.reduce((sum, file) => sum + file.conflictCount, 0);
    return <section className={styles.root} aria-label="Live repository map">
        <div className={styles.toolbar}><div><h2>Live map</h2><div className={styles.liveStatus}><span className={`${styles.pulse} ${live.paused || live.error || !live.running ? styles.paused : ''}`}/><strong role="status">{live.error ? 'Connection interrupted' : live.paused ? 'Paused' : live.running ? 'Live' : 'Waiting'}</strong><span>{refreshTime ? `Updated ${refreshTime}` : 'Connecting…'}</span></div></div><div className={styles.controls}><button aria-pressed={live.paused} onClick={() => live.setPaused(!live.paused)}>{live.paused ? <Play size={14}/> : <Pause size={14}/>} {live.paused ? 'Resume' : 'Pause'}</button><button disabled={live.loading} onClick={() => void live.refresh()} aria-label="Refresh live map"><RefreshCw size={15} className={live.loading ? styles.spinning : ''}/>Refresh</button></div></div>
        {live.error && <div className={styles.error} role="alert">{snapshot ? 'Showing the last successful snapshot. ' : 'The live map could not load. '}{live.error} <button onClick={() => void live.refresh()}>Try again</button></div>}
        {snapshot && <>
            <div className={styles.metrics}><div><FileCode2 size={17}/><strong>{rankedFiles.filter(file => file.lockCount > 0).length}</strong><span>locked files</span></div><div><LockKeyhole size={17}/><strong>{rankedFiles.reduce((sum, file) => sum + file.lockCount, 0)}</strong><span>held locks</span></div><div className={conflictCount ? styles.hotMetric : ''}><Activity size={17}/><strong>{conflictCount}</strong><span>conflicting locks</span></div><div><GitBranch size={17}/><strong>{snapshot.summary.waitingCount}</strong><span>waiting requests</span></div></div>
            <div className={styles.filterBar}><div className={styles.viewSwitch} role="group" aria-label="Live map view"><button aria-pressed={view === 'list'} onClick={() => chooseView('list')}><List size={15}/>Ranked files</button><button aria-pressed={view === 'graph'} onClick={() => chooseView('graph')}><Network size={15}/>Lock graph</button></div><label className={styles.search}><Search size={16}/><input aria-label="Find a file in the live map" placeholder="Find a file…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/></label>{view === 'list' && <label className={styles.checkbox}><input type="checkbox" checked={activityOnly} onChange={event => { setActivityOnly(event.target.checked); setPage(0); }}/>With lock activity</label>}</div>
            {view === 'list' ? <>
                <div className={styles.listHeading}><p>Sorted by conflicting locks, held locks, then latest activity.</p><span>{filteredFiles.length} of {snapshot.files.length} files</span></div>
                {files.length ? <div className={styles.tableScroll}><table className={styles.fileTable}><caption className={styles.srOnly}>Files ranked by conflicting locks, held locks, and latest recorded file activity, all descending</caption><thead><tr><th scope="col">File</th><th scope="col" title="Unique held locks blocking another journey’s current request">Conflicting</th><th scope="col">Held</th><th scope="col">Waiting</th><th scope="col">Updated</th></tr></thead><tbody>{files.map(file => <tr key={file.path} data-map-file={file.path} className={selection.file === file.path ? styles.selectedRow : ''}><td><button className={styles.fileButton} aria-controls={inspectorId} aria-label={`Inspect ${file.path}`} aria-pressed={selection.file === file.path} onClick={() => chooseFile(file)} title={file.path}><FileCode2 size={17}/><span><strong>{fileName(file.path)}</strong><small>{directory(file.path)}{!file.exists ? ' · New / absent' : ''}</small></span></button></td><td><span className={file.conflictCount ? styles.conflictBadge : styles.neutralCount}>{file.conflictCount}</span></td><td>{file.lockCount}</td><td>{file.waitingCount}</td><td className={styles.date}>{file.updatedAt ? <time dateTime={new Date(file.updatedAt).toISOString()} title={new Date(file.updatedAt).toLocaleString()}>{activityDate(file.updatedAt)}</time> : '—'}</td></tr>)}</tbody></table></div> : <div className={styles.empty}><FileCode2 size={28}/><h3>{snapshot.files.length ? 'No matching file activity' : 'Your map is ready for code'}</h3><p>{snapshot.files.length ? 'Clear the search or turn off “With lock activity” to see other files.' : 'Import a repository or request a lock on a new file to see it here.'}</p></div>}
            </> : <LockGraph files={files} changesets={snapshot.changesets} selection={selection} onSelect={inspect}/>}
            <Pager page={safePage} count={filteredFiles.length} onChange={setPage}/>
            <div className={styles.inspector} ref={inspector} id={inspectorId} tabIndex={-1} aria-label="Map inspector">
                {selectedFile || selectedChange ? <><div className={styles.inspectorHeading}><div><span className={styles.eyebrow}>{selectedFile ? 'FILE INSPECTOR' : 'CHANGESET INSPECTOR'}</span><h3>{selectedFile?.path ?? selectedChange?.description}</h3></div><button onClick={() => setSelection({})} aria-label="Clear map selection"><X size={17}/></button></div>
                    {selectedFile ? <div className={styles.inspectorGrid}><div className={styles.inspectorSummary}><p>{selectedFile.exists ? `${selectedFile.lineCount.toLocaleString()} lines in main` : 'Path is absent from the current main revision.'}</p><p>{selectedFile.lockCount} held locks · {selectedFile.conflictCount} conflicting · {selectedFile.waitingCount} waiting requests</p><p>Updated: {activityDate(selectedFile.updatedAt)}</p>{selectedFile.exists && <a href={fileHref(selectedFile.path)}>Open source code<ArrowRight size={14}/></a>}</div><div className={styles.regionList}><h4>Editing scopes</h4>{selectedFile.regions.map(region => <button key={`${region.start}:${region.end}`} className={`${styles.regionRow} ${selectedRegion === region ? styles.selectedRow : ''}`} aria-pressed={selectedRegion === region} onClick={() => chooseFile(selectedFile, region)}><i className={styles[region.status]}/><span><strong>{scope(region)}{region.approximate ? ' ≈' : ''}</strong><small>{region.lockIds.length} held · {region.waitingIds.length} waiting{region.approximate ? ' · approximate' : ''}</small></span></button>)}{!selectedFile.regions.length && <p>No active editing scopes.</p>}</div><div className={styles.relatedList}><h4>{selectedRegion ? `Changesets in ${scope(selectedRegion).toLowerCase()}` : 'Related changesets'}</h4>{connectedChangesets.filter(change => !selectedRegion || selectedRegion.changesetIds.includes(change.id)).map(change => <button key={change.id} onClick={() => inspect({ changeset: change.id })}><GitBranch size={13}/><span><strong>{change.title}</strong><small>{change.description}{selectedFile.heldLocks.some(lock => lock.changeset === change.id) ? ' · Holds locks' : ''}</small></span><ArrowRight size={13}/></button>)}{!connectedChangesets.length && <p>No recorded changesets touch this file.</p>}</div></div> : selectedChange && <div className={styles.inspectorGrid}><div className={styles.inspectorSummary}><p>{selectedChange.title}</p><p>{selectedChange.lockCount} held locks · {selectedChange.waitingCount} waiting requests · {selectedChange.patchCount} patches</p><a href={changesetHref(selectedChange)}>Open journey<ArrowRight size={14}/></a></div><div className={styles.affectedFiles}><h4>Locked files</h4>{lockedPaths.map(path => <button key={path} onClick={() => revealFile(path)}><FileCode2 size={13}/><span>{path}</span><ArrowRight size={13}/></button>)}{!lockedPaths.length && <p>This changeset holds no locks.</p>}</div><div className={styles.affectedFiles}><h4>All related files</h4>{selectedChange.paths.map(path => <button key={path} onClick={() => revealFile(path)}><FileCode2 size={13}/><span>{path}</span><ArrowRight size={13}/></button>)}</div></div>}
                </> : <div className={styles.inspectorHint}><Activity size={20}/><div><strong>Inspect activity without losing your place.</strong><p>Select a file or changeset to see its locks, waiting requests, and journey.</p></div></div>}
            </div>
            <footer className={styles.footnote}><span><GitBranch size={13}/>main <code>{snapshot.head.slice(0, 7)}</code> · event {snapshot.sequence}</span><p>A conflicting lock blocks another journey’s current request, including adjacent boundaries. Updated reflects recorded patch or lock activity. Waiting requests are deduplicated, not a queue position.</p></footer>
        </>}
        {!snapshot && !live.error && <div className={styles.empty} role="status"><RefreshCw size={26} className={styles.spinning}/><h3>Mapping repository activity…</h3><p>Finding files, editing scopes, and their changesets.</p></div>}
    </section>;
}
