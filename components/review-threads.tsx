'use client';

import { useId, useState, type ReactNode } from 'react';
import type { Journey, Review } from '@/lib/avc/core';
import type { ChangesetCommentTarget } from '@/lib/changeset-detail';
import { replyCommentTarget, reviewThreads } from '@/lib/review-threads';
import { submitCommentOnShortcut } from '@/lib/comment-shortcut';
import styles from './review-threads.module.css';

type Props = {
    reviews: Review[];
    journey: Pick<Journey, 'id' | 'head'>;
    canComment?: boolean;
    onComment?: (target: ChangesetCommentTarget) => Promise<boolean>;
    context?: (review: Review) => ReactNode;
    actions?: (review: Review) => ReactNode;
};

export function ReviewThreads(props: Props) {
    return <ol className={styles.threads}>{reviewThreads(props.reviews).map(thread => <Thread key={thread.root.id} {...props} {...thread}/>)}</ol>;
}

function Thread({ root, replies, journey, canComment, onComment, context, actions }: Props & { root: Review; replies: Review[] }) {
    const [replying, setReplying] = useState<Review | null>(null);
    const [draft, setDraft] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const inputId = useId();
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (!replying || !onComment || !canComment || pending || !draft.trim()) return;
        setPending(true);
        setError('');
        try {
            if (await onComment(replyCommentTarget(journey, replying, draft))) {
                setDraft('');
                setReplying(null);
            } else setError('Reply was not saved. Your draft is preserved; try again.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Reply was not saved. Your draft is preserved; try again.');
        } finally { setPending(false); }
    }
    function comment(review: Review, reply = false) {
        const parent = reply && review.replyTo !== root.id ? replies.find(item => item.id === review.replyTo) : undefined;
        return <article id={`${inputId}-${review.id}`} className={reply ? styles.reply : styles.comment}>
            <header><span className={styles.author}>{review.actor}</span><span>{reply ? 'replied' : review.kind === 'approve' ? 'approved' : review.kind === 'request_changes' ? 'requested changes' : 'commented'}</span><time dateTime={new Date(review.at).toISOString()} title={new Date(review.at).toLocaleString()}>{new Date(review.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></header>
            {parent && <a className={styles.replyContext} href={`#${inputId}-${parent.id}`} title={parent.body}>↳ {parent.body}</a>}
            {!reply && context?.(review)}
            <p className={styles.body}>{review.body}</p>
            <footer><code title={`Revision ${review.revision}`}>{review.revision.slice(0, 7)}</code>{review.revision !== journey.head && <span>Previous revision</span>}{review.resolved && <span>Resolved</span>}{actions?.(review)}{canComment && onComment && <button type="button" disabled={pending} onClick={() => { setReplying(review); setError(''); }}>Reply</button>}</footer>
        </article>;
    }
    return <li className={styles.thread}>
        {comment(root)}
        {replies.length > 0 && <ol className={styles.replies}>{replies.map(review => <li key={review.id}>{comment(review, true)}</li>)}</ol>}
        {replying && <form className={styles.composer} onSubmit={submit}>
            <label htmlFor={inputId}>Reply to <span>{replying.actor}</span></label>
            <textarea autoFocus id={inputId} rows={2} maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={submitCommentOnShortcut} disabled={pending || !canComment} placeholder="Write a reply…"/>
            {error && <p role="alert">{error}</p>}
            <div><button type="button" disabled={pending} onClick={() => { setReplying(null); setError(''); }}>Cancel</button><button type="submit" disabled={pending || !canComment || !draft.trim()}>{pending ? 'Posting…' : 'Post reply'}</button></div>
        </form>}
    </li>;
}
