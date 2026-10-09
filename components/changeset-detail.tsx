'use client';

import { useId, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { Changeset, Journey } from '@/lib/avc/core';
import { submitCommentOnShortcut } from '@/lib/comment-shortcut';
import { changesetCommentTarget, changesetDiscussion, type ChangesetCommentTarget } from '@/lib/changeset-detail';
import { ReviewThreads } from './review-threads';
import { PatchViewer } from './patch-viewer';
import styles from './changeset-detail.module.css';

type Props = {
    project: string;
    journey: Journey;
    changeset: Changeset;
    onComment: (target: ChangesetCommentTarget) => Promise<boolean>;
    canComment?: boolean;
    hrefForChangeset: (id: string) => string;
    onNavigateChangeset: (event: MouseEvent<HTMLAnchorElement>, id: string) => void;
};

export function ChangesetDetail(props: Props) {
    return <ChangesetContents key={`${props.project}:${props.journey.id}:${props.changeset.id}`} {...props}/>;
}

function ChangesetContents({ project, journey, changeset, onComment, canComment = true, hrefForChangeset, onNavigateChangeset }: Props) {
    const [draft, setDraft] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const inputId = useId();
    const headingRef = useRef<HTMLElement>(null);
    const reviews = changesetDiscussion(journey.reviews, changeset);
    const fileCount = new Set(changeset.patches.flatMap(patch => patch.changes.map(change => change.path))).size;
    const number = journey.changesets.findIndex(item => item.id === changeset.id) + 1;
    const previous = journey.changesets[number - 2];
    const next = journey.changesets[number];
    function navigate(event: MouseEvent<HTMLAnchorElement>, id: string) {
        onNavigateChangeset(event, id);
        if (event.defaultPrevented) headingRef.current?.scrollIntoView({ block: 'start' });
    }
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (!canComment || pending || !draft.trim()) return;
        setPending(true);
        setError('');
        try {
            const saved = await onComment(changesetCommentTarget(journey, changeset, draft));
            if (saved) setDraft('');
            else setError('Comment was not saved. Your draft is preserved; try again.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Comment was not saved. Your draft is preserved; try again.');
        } finally {
            setPending(false);
        }
    }
    return <article className={styles.detail}>
        {journey.changesets.length > 1 && <nav className={styles.navigation} aria-label="Changeset navigation">
            {previous ? <a href={hrefForChangeset(previous.id)} onClick={event => navigate(event, previous.id)} aria-label={`Previous changeset: ${previous.description}`} title={previous.description}><ArrowLeft size={16} aria-hidden="true"/>Back</a> : <button type="button" disabled aria-label="No previous changeset"><ArrowLeft size={16} aria-hidden="true"/>Back</button>}
            <span aria-live="polite">Changeset {number} of {journey.changesets.length}</span>
            {next ? <a href={hrefForChangeset(next.id)} onClick={event => navigate(event, next.id)} aria-label={`Next changeset: ${next.description}`} title={next.description}>Next<ArrowRight size={16} aria-hidden="true"/></a> : <button type="button" disabled aria-label="No next changeset">Next<ArrowRight size={16} aria-hidden="true"/></button>}
        </nav>}
        <header ref={headingRef} className={styles.heading}>
            <p>Changeset {number} · {journey.status === 'working' ? 'In progress' : journey.status}</p>
            <h2>{changeset.description}</h2>
            <p>{journey.title} · <code>{changeset.id.slice(0, 8)}</code></p>
        </header>
        <section aria-label="Changeset changes" className={styles.changes}>
            <h3>Changes <span>{changeset.patches.length} patches · {fileCount} files</span></h3>
            <p className={styles.note}>All patches in this changeset, in publication order.</p>
            {changeset.patches.length ? changeset.patches.map((patch, index) => <div key={patch.id} id={`patch-${patch.id}`}><PatchViewer project={project} patch={patch} number={`${number}.${index + 1}`} defaultOpen reviews={reviews.filter(review => review.patch === patch.id && review.anchor)} canComment={canComment} onComment={onComment} journey={journey} changeset={changeset}/></div>) : <p className={styles.empty}>No changes published yet.</p>}
        </section>
        <section aria-label="Changeset discussion" className={styles.discussion}>
            <h3>Discussion <span>{reviews.length}</span></h3>
            {reviews.length ? <ReviewThreads reviews={reviews} journey={journey} canComment={canComment} onComment={onComment} context={review => review.patch && <a href={`#patch-${review.patch}`}>Patch {changeset.patches.findIndex(patch => patch.id === review.patch) + 1}{review.anchor && ` · ${review.anchor.path}:${review.anchor.line}`}</a>}/> : <p className={styles.empty}>No comments on this changeset yet.</p>}
            <form onSubmit={submit} className={styles.composer}>
                <label htmlFor={inputId}>Comment on this changeset</label>
                <textarea onKeyDown={submitCommentOnShortcut} id={inputId} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Leave a comment…" rows={4} maxLength={4000} disabled={!canComment || pending}/>
                {error && <p role="alert" className={styles.error}>{error}</p>}
                <button type="submit" disabled={!canComment || pending || !draft.trim()}>{pending ? 'Posting…' : 'Comment'}</button>
            </form>
        </section>
    </article>;
}
