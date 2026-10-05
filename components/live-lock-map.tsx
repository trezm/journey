'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowRight, ChevronLeft, ChevronRight, FileCode2, GitBranch, Layers, LockKeyhole, Pause, Play, RefreshCw, Search, X } from 'lucide-react';
import { useLiveLockMap } from '@/hooks/use-live-lock-map';
import type { LiveChangeset, LiveFile, LiveRegion } from '@/lib/avc/live';
import { homeRoute, workspaceHref } from '@/lib/workspace-route';
import styles from './live-lock-map.module.css';

const FILE_PAGE = 6;
const CHANGESET_PAGE = 6;
const statusNames = { locked: 'Locked', waiting: '1 waiting request', contended: 'Multiple waiting requests' };
const statusRank = { locked: 1, waiting: 2, contended: 3 };
const fileRank = (file: LiveFile) => Math.max(0, ...file.regions.map(region => statusRank[region.status]));
const changeOrder = (a: LiveChangeset, b: LiveChangeset) => b.waitingCount - a.waitingCount || b.lockCount - a.lockCount || a.title.localeCompare(b.title);
const uniqueWaiters = (file: LiveFile) => new Set(file.regions.flatMap(region => region.waitingIds)).size;
const scope = (region: LiveRegion) => region.start === region.end ? `Line ${region.start}` : `Lines ${region.start}–${region.end}`;
const fileName = (path: string) => path.split('/').at(-1) ?? path;
const directory = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '/';

type MapBounds = { left: number; right: number; top: number; bottom: number };

/** Keep a left-column connection out of its sibling card before entering the right gutter. */
export function mapConnectionPath(source: MapBounds, target: MapBounds, files: MapBounds[]) {
    const targetX = target.left, targetY = (target.top + target.bottom) / 2;
    const rightSiblings = files.filter(file => file.left >= source.right && file.top < source.bottom && file.bottom > source.top);
    const rightmost = Math.max(source.right, ...files.map(file => file.right));
    if (source.right < rightmost) {
        const rowBottom = Math.max(source.bottom, ...rightSiblings.map(file => file.bottom));
        const nextRowTop = Math.min(Infinity, ...files.filter(file => file.top >= rowBottom).map(file => file.top));
        // At most 7px fits both the smallest inter-row gap and the final 20px of padding.
        const gap = Math.min(7, (nextRowTop - rowBottom) / 2);
        const rowY = rowBottom + gap;
        const gutterX = rightmost + Math.min(7, (targetX - rightmost) / 3);
        const startX = source.right - Math.min(8, (source.right - source.left) / 4);
        const bend = (targetX - gutterX) * .55;
        return `M ${startX} ${source.bottom} L ${startX} ${rowY} L ${gutterX} ${rowY} C ${gutterX + bend} ${rowY}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}`;
    }
    const sourceX = source.right, sourceY = (source.top + source.bottom) / 2;
    const bend = (targetX - sourceX) * .55;
    return `M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}`;
}

type Edge = { id: string; path: string; active: boolean };
function Connections({ files, changesets, selectedFile, selectedChangeset, surface }: {
    files: LiveFile[]; changesets: LiveChangeset[]; selectedFile: string; selectedChangeset: string;
    surface: React.RefObject<HTMLDivElement | null>;
}) {
    const [edges, setEdges] = useState<Edge[]>([]);
    useEffect(() => {
        const element = surface.current;
        if (!element) return;
        const measure = () => {
            const box = element.getBoundingClientRect();
            const fileNodes = new Map(Array.from(element.querySelectorAll<HTMLElement>('[data-map-file]')).map(node => [node.dataset.mapFile, node]));
            const changeNodes = new Map(Array.from(element.querySelectorAll<HTMLElement>('[data-map-changeset]')).map(node => [node.dataset.mapChangeset, node]));
            const localBounds = (node: HTMLElement): MapBounds => {
                const rect = node.getBoundingClientRect();
                return { left: rect.left - box.left, right: rect.right - box.left, top: rect.top - box.top, bottom: rect.bottom - box.top };
            };
            const fileBounds = new Map(Array.from(fileNodes, ([path, node]) => [path, localBounds(node)]));
            const obstacles = [...fileBounds.values()];
            const next: Edge[] = [];
            for (const change of changesets) {
                const targetNode = changeNodes.get(change.id);
                if (!targetNode) continue;
                const target = localBounds(targetNode);
                for (const file of files.filter(file => change.paths.includes(file.path))) {
                    const source = fileBounds.get(file.path);
                    if (!source) continue;
                    next.push({ id: `${file.path}:${change.id}`, path: mapConnectionPath(source, target, obstacles), active: selectedFile === file.path || selectedChangeset === change.id });
                }
            }
            setEdges(next);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [files, changesets, selectedFile, selectedChangeset, surface]);
    return <svg className={styles.connections} aria-hidden="true">{[...edges].sort((a, b) => Number(a.active) - Number(b.active)).map(edge => <path key={edge.id} d={edge.path} className={edge.active ? styles.activeEdge : undefined}/>)}</svg>;
}

function MiniMap({ file, selectedRegion, onSelectRegion }: { file: LiveFile; selectedRegion?: LiveRegion; onSelectRegion: (region: LiveRegion) => void }) {
    // Neutral marks give the map a line scale; they are deliberately not source-code previews.
    return <div className={styles.miniMap} aria-label={`Editing scopes in ${file.path}`}>
        <div className={styles.lineScale}><span>1</span><span>{file.lineCount.toLocaleString()}</span></div>
        <div className={styles.lineTexture} aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <i key={index} style={{ width: `${34 + ((index * 29 + file.path.length * 7) % 62)}%` }}/>)}</div>
        <div className={styles.bands}>{file.regions.map(region => <button
            key={`${region.start}:${region.end}`}
            className={`${styles.band} ${styles[region.status]} ${selectedRegion === region ? styles.selectedBand : ''}`}
            style={{ top: `${(region.start - 1) / file.lineCount * 100}%`, height: `${Math.max(.8, (region.end - region.start + 1) / file.lineCount * 100)}%` }}
            title={`${scope(region)} · ${statusNames[region.status]} · ${region.lockIds.length} held · ${region.waitingIds.length} waiting${region.approximate ? ' · approximate position' : ''}`}
            aria-label={`${file.path}, ${scope(region)}, ${region.lockIds.length} held, ${region.waitingIds.length} waiting${region.approximate ? ', approximate position' : ''}`}
            aria-pressed={selectedRegion === region}
            onClick={() => onSelectRegion(region)}
        />)}</div>
    </div>;
}
function Pager({ page, count, size, name, onChange }: { page: number; count: number; size: number; name: string; onChange: (page: number) => void }) {
    const last = Math.max(0, Math.ceil(count / size) - 1);
    if (last === 0) return null;
    return <div className={styles.pager}><button aria-label={`Previous ${name}`} disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft size={15}/></button><span>{page * size + 1}–{Math.min(count, (page + 1) * size)} of {count}</span><button aria-label={`Next ${name}`} disabled={page >= last} onClick={() => onChange(page + 1)}><ChevronRight size={15}/></button></div>;
}

export function LiveLockMap({ project }: { project: string }) {
    const live = useLiveLockMap(project);
    const [query, setQuery] = useState('');
    const [activityOnly, setActivityOnly] = useState(false);
    const [includeCompleted, setIncludeCompleted] = useState(false);
    const [filePage, setFilePage] = useState(0);
    const [changesetPage, setChangesetPage] = useState(0);
    const [selection, setSelection] = useState<{ file?: string; changeset?: string; start?: number; end?: number }>({});
    const surface = useRef<HTMLDivElement>(null);
    const snapshot = live.data;
    const filteredFiles = useMemo(() => (snapshot?.files ?? []).filter(file => file.path.toLowerCase().includes(query.trim().toLowerCase()) && (!activityOnly || file.regions.length > 0)).sort((a, b) => fileRank(b) - fileRank(a) || a.path.localeCompare(b.path)), [snapshot, query, activityOnly]);
    const filteredChangesets = useMemo(() => {
        const paths = new Set(filteredFiles.map(file => file.path));
        return (snapshot?.changesets ?? []).filter(change => (includeCompleted || change.status === 'working' || change.status === 'review') && (!query.trim() && !activityOnly || change.paths.some(path => paths.has(path))))
            .sort(changeOrder);
    }, [snapshot, filteredFiles, query, activityOnly, includeCompleted]);
    const safeFilePage = Math.min(filePage, Math.max(0, Math.ceil(filteredFiles.length / FILE_PAGE) - 1));
    const safeChangesetPage = Math.min(changesetPage, Math.max(0, Math.ceil(filteredChangesets.length / CHANGESET_PAGE) - 1));
    const files = useMemo(() => filteredFiles.slice(safeFilePage * FILE_PAGE, (safeFilePage + 1) * FILE_PAGE), [filteredFiles, safeFilePage]);
    const changesets = useMemo(() => filteredChangesets.slice(safeChangesetPage * CHANGESET_PAGE, (safeChangesetPage + 1) * CHANGESET_PAGE), [filteredChangesets, safeChangesetPage]);
    const selectedFile = snapshot?.files.find(file => file.path === selection.file);
    const selectedChange = snapshot?.changesets.find(change => change.id === selection.changeset);
    const selectedRegion = selectedFile?.regions.find(region => region.start === selection.start && region.end === selection.end);
    const connectedChangesets = selectedFile ? (snapshot?.changesets ?? []).filter(change => change.paths.includes(selectedFile.path)) : [];
    const selectionVisible = !!selectedFile || !!selectedChange;
    function chooseFile(file: LiveFile, region?: LiveRegion) {
        setSelection({ file: file.path, start: region?.start, end: region?.end });
        const index = filteredChangesets.findIndex(change => region ? region.changesetIds.includes(change.id) : change.paths.includes(file.path));
        if (index >= 0) setChangesetPage(Math.floor(index / CHANGESET_PAGE));
    }
    function revealFile(path: string) {
        setQuery(''); setActivityOnly(false);
        const index = [...(snapshot?.files ?? [])].sort((a, b) => fileRank(b) - fileRank(a) || a.path.localeCompare(b.path)).findIndex(file => file.path === path);
        setFilePage(Math.max(0, Math.floor(index / FILE_PAGE)));
        setSelection({ file: path });
        const related = (snapshot?.changesets ?? []).filter(change => includeCompleted || change.status === 'working' || change.status === 'review').sort(changeOrder).findIndex(change => change.paths.includes(path));
        if (related >= 0) setChangesetPage(Math.floor(related / CHANGESET_PAGE));
    }
    function chooseChangeset(change: LiveChangeset) {
        setSelection({ changeset: change.id });
        let changeIndex = filteredChangesets.findIndex(item => item.id === change.id);
        let fileIndex = filteredFiles.findIndex(file => change.paths.includes(file.path));
        if (changeIndex < 0 || fileIndex < 0) {
            // Inspector links can reach completed work or nodes outside the current filter.
            const completed = includeCompleted || change.status === 'integrated' || change.status === 'abandoned';
            setIncludeCompleted(completed); setQuery(''); setActivityOnly(false);
            changeIndex = (snapshot?.changesets ?? []).filter(item => completed || item.status === 'working' || item.status === 'review').sort(changeOrder).findIndex(item => item.id === change.id);
            fileIndex = [...(snapshot?.files ?? [])].sort((a, b) => fileRank(b) - fileRank(a) || a.path.localeCompare(b.path)).findIndex(file => change.paths.includes(file.path));
        }
        if (changeIndex >= 0) setChangesetPage(Math.floor(changeIndex / CHANGESET_PAGE));
        if (fileIndex >= 0) setFilePage(Math.floor(fileIndex / FILE_PAGE));
    }
    const fileHref = (path: string) => workspaceHref({ ...homeRoute, project, path });
    const changesetHref = (change: LiveChangeset) => workspaceHref({ ...homeRoute, project, journey: change.journey, tab: 'changesets', mode: 'journey' });
    const refreshTime = live.receivedAt ? new Date(live.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    return <section className={styles.root} aria-label="Live repository map">
        <div className={styles.toolbar}>
            <div className={styles.liveStatus}><span className={`${styles.pulse} ${live.paused || live.error || !live.running ? styles.paused : ''}`}/><strong role="status">{live.error ? 'Connection interrupted' : live.paused ? 'Paused' : live.running ? 'Live' : 'Waiting'}</strong><span>{refreshTime ? `Updated ${refreshTime}` : 'Connecting…'}</span></div>
            <div className={styles.controls}><button aria-pressed={live.paused} onClick={() => live.setPaused(!live.paused)}>{live.paused ? <Play size={14}/> : <Pause size={14}/>} {live.paused ? 'Resume' : 'Pause'}</button><button disabled={live.loading} onClick={() => void live.refresh()} aria-label="Refresh live map"><RefreshCw size={15} className={live.loading ? styles.spinning : ''}/>Refresh</button></div>
        </div>
        {live.error && <div className={styles.error} role="alert">{snapshot ? 'Showing the last successful snapshot. ' : 'The live map could not load. '}{live.error} <button onClick={() => void live.refresh()}>Try again</button></div>}
        {snapshot && <>
            <div className={styles.metrics}>
                <div><FileCode2 size={17}/><strong>{snapshot.summary.fileCount}</strong><span>files mapped</span></div>
                <div><LockKeyhole size={17}/><strong>{snapshot.summary.lockedRegions}</strong><span>locked regions</span></div>
                <div><Activity size={17}/><strong>{snapshot.summary.waitingCount}</strong><span>waiting requests</span></div>
                <div className={snapshot.summary.contendedRegions ? styles.hotMetric : ''}><Layers size={17}/><strong>{snapshot.summary.contendedRegions}</strong><span>contended regions</span></div>
            </div>
            <div className={styles.filterBar}>
                <label className={styles.search}><Search size={16}/><input aria-label="Find a file in the live map" placeholder="Find a file…" value={query} onChange={event => { setQuery(event.target.value); setFilePage(0); setChangesetPage(0); }}/></label>
                <label className={styles.checkbox}><input type="checkbox" checked={activityOnly} onChange={event => { setActivityOnly(event.target.checked); setFilePage(0); setChangesetPage(0); }}/>With lock activity</label>
                <label className={styles.checkbox}><input type="checkbox" checked={includeCompleted} onChange={event => { setIncludeCompleted(event.target.checked); setChangesetPage(0); }}/>Include completed</label>
            </div>
            <div className={styles.legend} aria-label="Lock color legend"><span><i className={styles.locked}/>Locked</span><span><i className={styles.waiting}/>1 waiting</span><span><i className={styles.contended}/>2+ waiting</span><span><i className={styles.clear}/>Unreserved</span><small>Waiting requests override blue where they overlap.</small></div>
            <div className={styles.mapHead}><div><strong>FILES</strong><span>{filteredFiles.length} shown by filter</span></div><div><strong>CHANGESETS</strong><span>{filteredChangesets.length} {includeCompleted ? 'total' : 'active'}</span></div></div>
            <div className={styles.surface} ref={surface}>
                <Connections files={files} changesets={changesets} selectedFile={selectedFile?.path ?? ''} selectedChangeset={selectedChange?.id ?? ''} surface={surface}/>
                <div className={styles.files}>
                    {files.map(file => {
                        const related = selectedChange?.paths.includes(file.path);
                        const selected = selectedFile?.path === file.path;
                        const dimmed = selectionVisible && !selected && !related;
                        const waiting = uniqueWaiters(file);
                        return <article key={file.path} data-map-file={file.path} className={`${styles.fileCard} ${selected || related ? styles.selectedCard : ''} ${dimmed ? styles.dimmed : ''}`}>
                            <button className={styles.fileHeading} aria-pressed={selected} onClick={() => chooseFile(file)} title={file.path}><FileCode2 size={16}/><span><strong>{fileName(file.path)}</strong><small>{directory(file.path)}</small></span><span className={styles.fileBadge}>{file.exists ? `${file.lineCount.toLocaleString()} L` : 'New / absent'}</span></button>
                            <MiniMap file={file} selectedRegion={selected ? selectedRegion : undefined} onSelectRegion={region => chooseFile(file, region)}/>
                            <button className={styles.fileFooter} onClick={() => chooseFile(file)}><span>{file.regions.length ? <><i className={styles[fileRank(file) === 3 ? 'contended' : fileRank(file) === 2 ? 'waiting' : 'locked']}/>{file.regions.length} {file.regions.length === 1 ? 'region' : 'regions'}</> : 'No active locks'}</span><span>{waiting ? `${waiting} waiting` : 'Inspect'}<ArrowRight size={12}/></span></button>
                        </article>;
                    })}
                    {!files.length && <div className={styles.empty}><FileCode2 size={28}/><h3>{snapshot.files.length ? 'No matching files' : 'Your map is ready for code'}</h3><p>{snapshot.files.length ? 'Try another search or turn off the activity filter.' : 'Import a repository or request a lock on a new file to see it here.'}</p></div>}
                </div>
                <div className={styles.changesets}>
                    {changesets.map(change => {
                        const related = selectedFile && change.paths.includes(selectedFile.path);
                        const selected = selectedChange?.id === change.id;
                        return <button key={change.id} data-map-changeset={change.id} className={`${styles.changesetCard} ${selected || related ? styles.selectedCard : ''} ${selectionVisible && !selected && !related ? styles.dimmed : ''}`} aria-pressed={selected} onClick={() => chooseChangeset(change)}>
                            <div className={styles.changeTitle}><span className={styles.changeIcon}><Layers size={15}/></span><span>{change.title}</span><span className={`${styles.changeStatus} ${change.status === 'review' ? styles.reviewStatus : ''}`}>{change.status === 'working' ? 'Working' : change.status === 'review' ? 'Review' : change.status === 'integrated' ? 'Integrated' : 'Abandoned'}</span></div>
                            <strong>{change.description}</strong>
                            <div className={styles.changeMeta}><span>{change.paths.length} files · {change.patchCount} patches</span>{change.waitingCount ? <b>{change.waitingCount} waiting</b> : <span>{change.lockCount} locks</span>}</div>
                        </button>;
                    })}
                    {!changesets.length && <div className={styles.emptyChangesets}><Layers size={25}/><strong>No {includeCompleted ? 'matching' : 'active'} changesets</strong><p>Changesets connect to the files they lock, request, or change.</p></div>}
                </div>
            </div>
            <div className={styles.pagination}><Pager page={safeFilePage} count={filteredFiles.length} size={FILE_PAGE} name="files" onChange={setFilePage}/><Pager page={safeChangesetPage} count={filteredChangesets.length} size={CHANGESET_PAGE} name="changesets" onChange={setChangesetPage}/></div>
            <div className={styles.inspector} aria-label="Map inspector">
                {selectionVisible ? <>
                    <div className={styles.inspectorHeading}><span><span className={styles.eyebrow}>{selectedFile ? 'FILE INSPECTOR' : 'CHANGESET INSPECTOR'}</span><h3>{selectedFile?.path ?? selectedChange?.description}</h3></span><button onClick={() => setSelection({})} aria-label="Clear map selection"><X size={17}/></button></div>
                    {selectedFile ? <div className={styles.inspectorGrid}>
                        <div className={styles.inspectorSummary}><p>{selectedFile.exists ? `${selectedFile.lineCount.toLocaleString()} lines in main` : 'Path is absent from the current main revision.'}</p><p>{new Set(selectedFile.regions.flatMap(region => region.lockIds)).size} held locks · {uniqueWaiters(selectedFile)} waiting requests</p>{selectedFile.exists && <a href={fileHref(selectedFile.path)}>Open source code<ArrowRight size={14}/></a>}{!selectedFile.exists && <p className={styles.note}>The map uses a virtual line scale for new or removed files. Open a related journey to inspect its revision.</p>}</div>
                        <div className={styles.regionList}><h4>Editing scopes</h4>{selectedFile.regions.map(region => <button key={`${region.start}:${region.end}`} className={`${styles.regionRow} ${selectedRegion === region ? styles.selectedRow : ''}`} aria-pressed={selectedRegion === region} onClick={() => chooseFile(selectedFile, region)}><i className={styles[region.status]}/><span><strong>{scope(region)}{region.approximate ? ' ≈' : ''}</strong><small>{region.lockIds.length} held · {region.waitingIds.length} waiting{region.approximate ? ' · approximate' : ''}</small></span></button>)}{!selectedFile.regions.length && <p>No active editing scopes.</p>}</div>
                        <div className={styles.relatedList}><h4>{selectedRegion ? `Changesets in ${scope(selectedRegion).toLowerCase()}` : 'Related changesets'}</h4>{connectedChangesets.filter(change => !selectedRegion || selectedRegion.changesetIds.includes(change.id)).map(change => <button key={change.id} onClick={() => chooseChangeset(change)}><GitBranch size={13}/><span><strong>{change.title}</strong><small>{change.description}</small></span><ArrowRight size={13}/></button>)}{!connectedChangesets.length && <p>No recorded changesets touch this file.</p>}</div>
                    </div> : selectedChange && <div className={styles.inspectorGrid}>
                        <div className={styles.inspectorSummary}><p>{selectedChange.title}</p><p>{selectedChange.lockCount} held locks · {selectedChange.waitingCount} waiting requests · {selectedChange.patchCount} patches</p><a href={changesetHref(selectedChange)}>Open journey<ArrowRight size={14}/></a></div>
                        <div className={styles.affectedFiles}><h4>Connected files</h4>{selectedChange.paths.map(path => <button key={path} onClick={() => revealFile(path)}><FileCode2 size={13}/><span>{path}</span><ArrowRight size={13}/></button>)}{!selectedChange.paths.length && <p>No files requested or changed yet.</p>}</div>
                    </div>}
                </> : <div className={styles.inspectorHint}><Activity size={20}/><div><strong>Follow a thread through the repository.</strong><p>Select a file, a colored region, or a changeset to inspect its connections.</p></div></div>}
            </div>
            <footer className={styles.footnote}><span><GitBranch size={13}/>main <code>{snapshot.head.slice(0, 7)}</code> · event {snapshot.sequence}</span><p>Live requests are deduplicated estimates, not a queue position. Line positions may be approximate across revisions. Connections include recorded patches.</p></footer>
        </>}
        {!snapshot && !live.error && <div className={styles.loading} role="status"><RefreshCw size={26} className={styles.spinning}/><h3>Mapping repository activity…</h3><p>Finding files, editing scopes, and their changesets.</p></div>}
    </section>;
}
