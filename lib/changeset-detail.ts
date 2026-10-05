import type { Changeset, Journey, Review } from './avc/core.ts';

export type ChangesetCommentTarget = { journey: string; changeset: string; revision: string; body: string };

export function changesetDiscussion(reviews: Review[], changeset: Changeset) {
    const patches = new Set(changeset.patches.map(patch => patch.id));
    return reviews.filter(review => review.changeset === changeset.id || (!review.changeset && !!review.patch && patches.has(review.patch)))
        .sort((a, b) => a.at - b.at);
}

export function changesetCommentTarget(journey: Pick<Journey, 'id' | 'head'>, changeset: Pick<Changeset, 'id'>, body: string): ChangesetCommentTarget {
    return { journey: journey.id, changeset: changeset.id, revision: journey.head, body: body.trim() };
}
