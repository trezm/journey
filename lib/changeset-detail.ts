import type { Changeset, Journey, Patch, Review } from './avc/core.ts';

export type CommentLineAnchor = { path: string; side: 'before' | 'after'; line: number; context: string };
export type ChangesetCommentTarget = { journey: string; changeset?: string; replyTo?: string; revision: string; body: string; patch?: string; anchor?: CommentLineAnchor };

export function changesetDiscussion(reviews: Review[], changeset: Changeset) {
    const patches = new Set(changeset.patches.map(patch => patch.id));
    return reviews.filter(review => review.changeset === changeset.id || (!review.changeset && !!review.patch && patches.has(review.patch)))
        .sort((a, b) => a.at - b.at);
}

export function changesetCommentTarget(journey: Pick<Journey, 'id' | 'head'>, changeset: Pick<Changeset, 'id'>, body: string): ChangesetCommentTarget {
    return { journey: journey.id, changeset: changeset.id, revision: journey.head, body: body.trim() };
}

export function patchLineCommentTarget(journey: Pick<Journey, 'id' | 'head'>, changeset: Pick<Changeset, 'id'>, patch: Pick<Patch, 'id'>, anchor: CommentLineAnchor, body: string): ChangesetCommentTarget {
    return { ...changesetCommentTarget(journey, changeset, body), patch: patch.id, anchor: { ...anchor } };
}
