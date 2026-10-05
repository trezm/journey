'use client';

import { Fragment, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { ChevronDown, GitCommitHorizontal } from 'lucide-react';
import type { Files, Patch } from '@/lib/avc/core';
import { useRepositoryFiles } from '@/hooks/use-repository';
import { patchFileStatus, patchSections, type DiffLine } from '@/lib/patch-diff';
import { PatchReview, patchReviewKey } from '@/lib/patch-review';
import { highlightCode } from '@/lib/syntax-highlight';
import { SyntaxLine } from '@/components/syntax-code';
import styles from './patch-viewer.module.css';

type View = 'split' | 'unified';
const short = (revision: string) => revision.slice(0, 7);

export function PatchViewer({ project, patch, number, defaultOpen = false }: { project: string; patch: Patch; number: string; defaultOpen?: boolean }) {
    const [requested, setRequested] = useState(defaultOpen);
    return <details open={defaultOpen} className={styles.patch} onToggle={event => { if (event.currentTarget.open) setRequested(true); }}>
        <summary className={styles.summary}>
            <GitCommitHorizontal size={17}/>
            <div><strong>{patch.description}</strong><span>Patch {number} · {patch.changes.length} {patch.changes.length === 1 ? 'file' : 'files'} · {new Date(patch.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
            <code>{short(patch.after)}</code><ChevronDown size={14}/>
        </summary>
        {requested && <PatchContents key={patchReviewKey(project, patch)} project={project} patch={patch}/>}
    </details>;
}

function PatchContents({ project, patch }: { project: string; patch: Patch }) {
    const [view, setView] = useState<View>('split');
    const [review] = useState(() => new PatchReview(patchReviewKey(project, patch), () => window.localStorage));
    const viewedPaths = useSyncExternalStore(review.subscribe, review.snapshot, review.serverSnapshot);
    const viewedFiles = new Set(viewedPaths);
    const viewedCount = patch.changes.filter(change => viewedFiles.has(change.path)).length;
    const before = useRepositoryFiles(project, patch.before);
    const after = useRepositoryFiles(project, patch.after);
    const ready = before.status === 'ready' && after.status === 'ready';
    const error = before.error || after.error;
    return <div className={styles.contents}>
        <div className={styles.toolbar}>
            <div className={styles.revisions}><span>Before <code>{short(patch.before)}</code></span><span>After <code>{short(patch.after)}</code></span></div>
            <span className={styles.reviewProgress} role="status" title="Saved in this browser">{viewedCount} of {patch.changes.length} files viewed</span>
            <div className={styles.viewToggle} role="group" aria-label="Diff view">
                <button type="button" aria-pressed={view === 'unified'} onClick={() => setView('unified')}>Unified</button>
                <button type="button" aria-pressed={view === 'split'} onClick={() => setView('split')}>Side by side</button>
            </div>
        </div>
        {error ? <div className={styles.message} role="alert"><p>Unable to load this patch: {error}</p><button type="button" onClick={() => { void before.reload(); void after.reload(); }}>Retry</button></div>
            : !ready ? <p className={styles.message} role="status">Loading patch revisions…</p>
            : patch.changes.map(change => <PatchFile key={change.path} change={change} before={before.files} after={after.files} view={view} viewed={viewedFiles.has(change.path)} onViewedChange={value => review.setViewed(change.path, value)}/>)}
    </div>;
}

function PatchFile({ change, before, after, view, viewed, onViewedChange }: { change: Patch['changes'][number]; before: Files; after: Files; view: View; viewed: boolean; onViewedChange: (value: boolean) => void }) {
    const diffId = useId();
    const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
    const expanded = expandedChoice ?? !viewed;
    const oldText = Object.hasOwn(before, change.path) ? before[change.path] : undefined;
    const newText = Object.hasOwn(after, change.path) ? after[change.path] : undefined;
    const sections = useMemo(() => patchSections(oldText ?? '', newText ?? '', change.hunks), [oldText, newText, change.hunks]);
    const oldSyntax = useMemo(() => highlightCode(change.path, oldText ?? ''), [change.path, oldText]);
    const newSyntax = useMemo(() => highlightCode(change.path, newText ?? ''), [change.path, newText]);
    const additions = sections.reduce((total, section) => total + section.lines.filter(line => line.kind === 'added').length, 0);
    const removals = sections.reduce((total, section) => total + section.lines.filter(line => line.kind === 'removed').length, 0);
    const renderCode = (line: DiffLine, side: 'before' | 'after') => {
        const number = line[side];
        const tokens = (side === 'before' ? oldSyntax : newSyntax).lines[(number ?? 1) - 1];
        return <code>{tokens ? <SyntaxLine tokens={tokens}/> : line.text || ' '}</code>;
    };
    return <section className={`${styles.file} ${viewed ? styles.fileViewed : ''}`} aria-label={`Changes to ${change.path}`}>
        <div className={styles.fileHeading}>
            <button type="button" className={styles.fileToggle} aria-expanded={expanded} aria-controls={diffId} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${change.path}`} onClick={() => setExpandedChoice(!expanded)}><ChevronDown size={15} aria-hidden="true"/><strong>{change.path}</strong></button>
            <span>{patchFileStatus(oldText, newText)}</span><span className={styles.addedCount}>+{additions}</span><span className={styles.removedCount}>−{removals}</span>
            <label className={styles.viewedLabel}><input type="checkbox" checked={viewed} aria-label={`Mark ${change.path} as viewed`} onChange={event => { const checked = event.target.checked; onViewedChange(checked); setExpandedChoice(!checked); }}/><span>Viewed</span></label>
        </div>
        <div id={diffId} hidden={!expanded}>
        {expanded && <>{sections.some(section => section.lines.length) ? <div className={styles.scroll} tabIndex={0} role="region" aria-label={`${change.path} ${view === 'split' ? 'side by side' : 'unified'} diff`}>
            <table className={`${styles.diff} ${view === 'split' ? styles.split : styles.unified}`}>
                <caption className={styles.srOnly}>{change.path}: {view === 'split' ? 'before and after' : 'unified'} changes. Minus marks removed lines and plus marks added lines.</caption>
                <colgroup>{view === 'split' ? <><col className={styles.numberColumn}/><col/><col className={styles.numberColumn}/><col/></> : <><col className={styles.numberColumn}/><col className={styles.numberColumn}/><col/></>}</colgroup>
                <thead><tr>{view === 'split' ? <><th colSpan={2}>Before{oldText === undefined ? ' · File did not exist' : ''}</th><th colSpan={2}>After{newText === undefined ? ' · File deleted' : ''}</th></> : <><th scope="col">Old</th><th scope="col">New</th><th scope="col">Code</th></>}</tr></thead>
                <tbody>{sections.map((section, index) => <Fragment key={index}>
                    <tr className={styles.hunk}><td colSpan={view === 'split' ? 4 : 3}>@@ −{section.beforeStart},{section.beforeCount} +{section.afterStart},{section.afterCount} @@</td></tr>
                    {view === 'split' ? section.rows.map((row, i) => <tr key={i}>
                        {(['before', 'after'] as const).map(side => {
                            const line = row[side], className = line ? styles[line.kind] : styles.blank;
                            return <Fragment key={side}><td className={`${styles.number} ${className}`}>{line?.[side]}</td><td className={`${styles.code} ${className}`}><span className={styles.marker} aria-hidden="true">{line?.kind === 'removed' ? '−' : line?.kind === 'added' ? '+' : ' '}</span>{line && renderCode(line, side)}</td></Fragment>;
                        })}
                    </tr>) : section.lines.map((line, i) => <tr key={i} className={styles[line.kind]}><td className={styles.number}>{line.before}</td><td className={styles.number}>{line.after}</td><td className={styles.code}><span className={styles.marker} aria-hidden="true">{line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}</span>{renderCode(line, line.kind === 'removed' ? 'before' : 'after')}</td></tr>)}
                </Fragment>)}</tbody>
            </table>
        </div> : <p className={styles.message}>{oldText === undefined ? 'Empty file added.' : newText === undefined ? 'Empty file deleted.' : 'No visible line changes.'}</p>}
        {oldText !== undefined && newText !== undefined && oldText.endsWith('\n') !== newText.endsWith('\n') && <p className={styles.fileNote}>{newText.endsWith('\n') ? 'Final newline added.' : 'Final newline removed.'}</p>}
        </>}
        </div>
    </section>;
}
