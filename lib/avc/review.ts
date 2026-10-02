import type { Journey } from './core.ts';

export function integrationReviewBlocker(journey: Pick<Journey, 'status' | 'head' | 'reviews'>, requireApproval: boolean): string | null {
    if (journey.status !== 'review')
        return 'Submit this revision for review before integrating.';
    if (journey.reviews.some(review => review.kind === 'request_changes' && !review.resolved))
        return 'Resolve outstanding change requests before integrating.';
    if (requireApproval && !journey.reviews.some(review => review.kind === 'approve' && review.revision === journey.head && !review.resolved))
        return 'Awaiting approval of this revision.';
    return null;
}
