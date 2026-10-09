import type { Journey, Review } from './avc/core.ts';
import type { ChangesetCommentTarget } from './changeset-detail.ts';

/** Keep descendants at a single display depth; never infer relationships from prose. */
export function reviewThreads(reviews: Review[]) {
    const byId = new Map(reviews.map(review => [review.id, review]));
    const groups = new Map<string, { root: Review; replies: Review[] }>();
    for (const review of [...reviews].sort((a, b) => a.at - b.at)) {
        let root = review;
        const visited = new Set([root.id]);
        while (root.replyTo && byId.has(root.replyTo) && !visited.has(root.replyTo)) {
            root = byId.get(root.replyTo)!;
            visited.add(root.id);
        }
        if (root.replyTo && visited.has(root.replyTo)) root = review;
        const group = groups.get(root.id) ?? { root, replies: [] };
        groups.set(root.id, group);
        if (review.id !== root.id) group.replies.push(review);
    }
    return [...groups.values()].sort((a, b) => a.root.at - b.root.at);
}

export function replyCommentTarget(journey: Pick<Journey, 'id' | 'head'>, parent: Review, body: string): ChangesetCommentTarget {
    return { journey: journey.id, revision: journey.head, replyTo: parent.id, body: body.trim() };
}
