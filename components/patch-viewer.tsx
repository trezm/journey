'use client';

import { ReviewThreads } from './review-threads';

import { Fragment, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { ChevronDown, GitCommitHorizontal } from 'lucide-react';
import type { Files, Patch, Review } from '@/lib/avc/core';
import { useRepositoryFiles } from '@/hooks/use-repository';
import { patchFileStatus, patchSections, type DiffLine, type HunkContext } from '@/lib/patch-diff';
import { PatchReview, patchReviewKey } from '@/lib/patch-review';
import { patchLineCommentTarget, type ChangesetCommentTarget } from '@/lib/changeset-detail';
import type { Changeset, Journey } from '@/lib/avc/core';
import { highlightCode } from '@/lib/syntax-highlight';
import { submitCommentOnShortcut } from '@/lib/comment-shortcut';
import { SyntaxLine } from '@/components/syntax-code';
import styles from './patch-viewer.module.css';

type View = 'split' | 'unified';
const short = (revision: string) => revision.slice(0, 7);

type PatchViewerProps = { project: string; patch: Patch; number: string; defaultOpen?: boolean; reviews?: Review[]; canComment?: boolean; onComment?: (target: ChangesetCommentTarget) => Promise<boolean>; journey?: Pick<Journey, 'id' | 'head'>; changeset?: Pick<Changeset, 'id'> };

export function PatchViewer({ project, patch, number, defaultOpen = false, reviews = [], canComment = false, onComment, journey, changeset }: PatchViewerProps) {
    const [requested, setRequested] = useState(defaultOpen);
    return <details open={defaultOpen} className={styles.patch} onToggle={event => { if (event.currentTarget.open) setRequested(true); }}>
        <summary className={styles.summary}>
            <GitCommitHorizontal size={17}/>
            <div><strong>{patch.description}</strong><span>Patch {number} · {patch.changes.length} {patch.changes.length === 1 ? 'file' : 'files'} · {new Date(patch.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
            <code>{short(patch.after)}</code><ChevronDown size={14}/>
        </summary>
        {requested && <PatchContents key={patchReviewKey(project, patch)} project={project} patch={patch} reviews={reviews} canComment={canComment} onComment={onComment} journey={journey} changeset={changeset}/>}
    </details>;
}

function PatchContents({ project, patch, reviews = [], canComment = false, onComment, journey, changeset }: Omit<PatchViewerProps, 'number' | 'defaultOpen'>) {
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
            : patch.changes.map(change => <PatchFile key={change.path} change={change} before={before.files} after={after.files} view={view} viewed={viewedFiles.has(change.path)} onViewedChange={value => review.setViewed(change.path, value)} reviews={reviews.filter(item => item.patch === patch.id && item.anchor?.path === change.path)} patch={patch} canComment={canComment} onComment={onComment} journey={journey} changeset={changeset}/>)}
    </div>;
}

function PatchFile({ change, before, after, view, viewed, onViewedChange, reviews, patch, canComment, onComment, journey, changeset }: { change: Patch['changes'][number]; before: Files; after: Files; view: View; viewed: boolean; onViewedChange: (value: boolean) => void; reviews: Review[]; patch: Patch; canComment: boolean; onComment?: (target: ChangesetCommentTarget) => Promise<boolean>; journey?: Pick<Journey, 'id' | 'head'>; changeset?: Pick<Changeset, 'id'> }) {
    const diffId = useId();
    const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
    const [lineThreads, setLineThreads] = useState<Record<string, { open?: boolean; draft?: string; pending?: boolean; error?: string }>>({});
    const [context, setContext] = useState<HunkContext[]>([]);
    const expanded = expandedChoice ?? !viewed;
    const expandContext = (hunk: number, side: 'before' | 'after', hidden: number) => setContext(current => {
        const next = [...current];
        const padding = next[hunk] ?? { before: 3, after: 3 };
        next[hunk] = { ...padding, [side]: padding[side] + Math.min(10, hidden) };
        return next;
    });
    const threadProps = (side: 'before' | 'after', line: number) => {
        const key = `${side}:${line}`;
        return { thread: lineThreads[key] ?? {}, setThread: (updates: { open?: boolean; draft?: string; pending?: boolean; error?: string }) => setLineThreads(current => ({ ...current, [key]: { ...current[key], ...updates } })) };
    };
    const oldText = Object.hasOwn(before, change.path) ? before[change.path] : undefined;
    const newText = Object.hasOwn(after, change.path) ? after[change.path] : undefined;
    const sections = useMemo(() => patchSections(oldText ?? '', newText ?? '', change.hunks, context), [oldText, newText, change.hunks, context]);
    const oldSyntax = useMemo(() => highlightCode(change.path, oldText ?? ''), [change.path, oldText]);
    const newSyntax = useMemo(() => highlightCode(change.path, newText ?? ''), [change.path, newText]);
    const additions = sections.reduce((total, section) => total + section.lines.filter(line => line.kind === 'added').length, 0);
    const removals = sections.reduce((total, section) => total + section.lines.filter(line => line.kind === 'removed').length, 0);
    const renderCode = (line: DiffLine, side: 'before' | 'after') => {
        const number = line[side];
        const tokens = (side === 'before' ? oldSyntax : newSyntax).lines[(number ?? 1) - 1];
        const content = <><span className={styles.marker} aria-hidden="true">{line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}</span><code>{tokens ? <SyntaxLine tokens={tokens}/> : line.text || ' '}</code></>;
        return canComment && number !== undefined ? <button type="button" className={styles.lineTarget} aria-label={`Add comments on ${change.path}, ${side} line ${number}`} aria-expanded={lineThreads[`${side}:${number}`]?.open ?? false} onClick={() => { if (window.getSelection?.()?.isCollapsed === false) return; threadProps(side, number).setThread({ open: !lineThreads[`${side}:${number}`]?.open }); }}>{content}</button> : content;
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
                <tbody>{sections.map(section => <Fragment key={section.firstHunk}>
                    {section.hiddenBefore > 0 && <tr className={styles.contextControl}><td colSpan={view === 'split' ? 4 : 3}><button type="button" onClick={() => expandContext(section.firstHunk, 'before', section.hiddenBefore)}>↑ Expand up {Math.min(10, section.hiddenBefore)} lines</button></td></tr>}
                    <tr className={styles.hunk}><td colSpan={view === 'split' ? 4 : 3}>@@ −{section.beforeStart},{section.beforeCount} +{section.afterStart},{section.afterCount} @@</td></tr>
                    {view === 'split' ? section.rows.map((row, i) => <tr key={i}>
                        {(['before', 'after'] as const).map(side => {
                            const line = row[side], className = line ? styles[line.kind] : styles.blank;
                            const anchorSide = side;
                            return <Fragment key={side}><td className={`${styles.number} ${className}`}>{line?.[side]}</td><td className={`${styles.code} ${className}`}>{line && <>{renderCode(line, side)}<LineDiscussion {...threadProps(anchorSide, line[side]!)} path={change.path} side={anchorSide} line={line[side]!} context={line.text} patch={patch} reviews={reviews} canComment={canComment} onComment={onComment} journey={journey} changeset={changeset}/></>}</td></Fragment>;
                        })}
                    </tr>) : section.lines.map((line, i) => {
                        const side = line.kind === 'removed' ? 'before' : 'after';
                        const number = line[side];
                        return <tr key={i} className={styles[line.kind]}><td className={styles.number}>{line.before}</td><td className={styles.number}>{line.after}</td><td className={styles.code}>{renderCode(line, side)}{number !== undefined && <><LineDiscussion {...threadProps(side, number)} path={change.path} side={side} line={number} context={line.text} patch={patch} reviews={reviews} canComment={canComment} onComment={onComment} journey={journey} changeset={changeset}/>{line.kind === 'context' && line.before !== undefined && <LineDiscussion {...threadProps('before', line.before)} path={change.path} side="before" line={line.before} context={line.text} patch={patch} reviews={reviews} canComment={canComment} onComment={onComment} journey={journey} changeset={changeset}/>}</>}</td></tr>;
                    })}
                {section.hiddenAfter > 0 && <tr className={styles.contextControl}><td colSpan={view === 'split' ? 4 : 3}><button type="button" onClick={() => expandContext(section.lastHunk, 'after', section.hiddenAfter)}>↓ Expand down {Math.min(10, section.hiddenAfter)} lines</button></td></tr>}
                </Fragment>)}</tbody>
            </table>
        </div> : <p className={styles.message}>{oldText === undefined ? 'Empty file added.' : newText === undefined ? 'Empty file deleted.' : 'No visible line changes.'}</p>}
        {oldText !== undefined && newText !== undefined && oldText.endsWith('\n') !== newText.endsWith('\n') && <p className={styles.fileNote}>{newText.endsWith('\n') ? 'Final newline added.' : 'Final newline removed.'}</p>}
        </>}
        </div>
    </section>;
}

function LineDiscussion({ path, side, line, context, patch, reviews, canComment, onComment, journey, changeset, thread, setThread }: { path: string; side: 'before' | 'after'; line: number; context: string; patch: Patch; reviews: Review[]; canComment: boolean; onComment?: (target: ChangesetCommentTarget) => Promise<boolean>; journey?: Pick<Journey, 'id' | 'head'>; changeset?: Pick<Changeset, 'id'>; thread: { open?: boolean; draft?: string; pending?: boolean; error?: string }; setThread: (updates: { open?: boolean; draft?: string; pending?: boolean; error?: string }) => void }) {
    const open = thread.open ?? false, draft = thread.draft ?? '', pending = thread.pending ?? false, error = thread.error ?? '';
    const anchored = reviews.filter(review => review.anchor?.side === side && review.anchor.line === line);
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (!canComment || pending || !draft.trim() || !journey || !changeset || !onComment) return;
        setThread({ pending: true, error: '' });
        try {
            if (await onComment(patchLineCommentTarget(journey, changeset, patch, { path, side, line, context }, draft))) setThread({ draft: '', pending: false });
            else setThread({ error: 'Comment was not saved. Your draft is preserved; try again.', pending: false });
        } catch (cause) {
            setThread({ error: cause instanceof Error ? cause.message : 'Comment was not saved. Your draft is preserved; try again.', pending: false });
        }
    }
    return <>
        {anchored.length > 0 && <button type="button" className={styles.lineCommentToggle} aria-expanded={open || anchored.length > 0} aria-label={`View comments on ${path}, ${side} line ${line}`} onClick={() => setThread({ open: !open })}>{`● ${anchored.length}`}</button>}
        {(open || anchored.length > 0) && <div className={styles.lineThread}>
            <ReviewThreads reviews={anchored} journey={journey ?? { id: '', head: patch.after }} canComment={canComment && !!journey} onComment={onComment} context={review => review.anchor?.context && !context.startsWith(review.anchor.context) ? <small>Context differs from the patch snapshot: <code>{review.anchor.context}</code></small> : null}/>
            {open && canComment && <form onSubmit={submit} className={styles.lineComposer}><label className={styles.srOnly} htmlFor={`comment-${patch.id}-${path}-${side}-${line}`}>Comment on {path}, {side} line {line}</label><textarea onKeyDown={submitCommentOnShortcut} id={`comment-${patch.id}-${path}-${side}-${line}`} rows={2} maxLength={4000} value={draft} onChange={event => setThread({ draft: event.target.value })} disabled={pending} placeholder={`Comment on ${side} line ${line}…`}/>{error && <span role="alert">{error}</span>}<button type="submit" disabled={pending || !draft.trim()}>{pending ? 'Posting…' : 'Post comment'}</button></form>}
        </div>}
    </>;
}
