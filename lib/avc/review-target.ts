import { insist, type Journey } from './core.ts';

/** Comments remain available throughout a journey; review decisions require submission. */
export function validateReviewTarget(journey: Pick<Journey, 'status' | 'head' | 'changesets'>, input: { kind: unknown; revision: unknown; changeset?: unknown; patch?: unknown }) {
    insist(['comment', 'request_changes', 'approve'].includes(input.kind as string), 'invalid_review', 'Unknown review action.', 400);
    insist(input.kind === 'comment' || journey.status === 'review', 'not_in_review', 'The journey must be submitted for review.');
    insist(input.revision === journey.head, 'stale_review', 'This review targets an old revision.');
    const changeset = input.changeset === undefined ? undefined : journey.changesets.find(c => c.id === input.changeset);
    if (input.changeset !== undefined)
        insist(changeset, 'changeset_not_found', 'Invalid review anchor.', 404);
    if (input.patch !== undefined) {
        const owner = journey.changesets.find(c => c.patches.some(p => p.id === input.patch));
        insist(owner, 'patch_not_found', 'Invalid patch anchor.', 404);
        insist(!changeset || changeset.id === owner.id, 'invalid_review_anchor', 'The patch does not belong to this changeset.', 400);
    }
}
