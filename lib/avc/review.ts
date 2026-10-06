import type { Journey } from './core.ts';

export function hasCurrentApproval(journey: Pick<Journey, 'head' | 'reviews'>, allowCoordinatorApproval = false): boolean {
    return journey.reviews.some(review => review.kind === 'approve' && review.revision === journey.head && !review.resolved && (review.authority !== 'coordinator' || allowCoordinatorApproval));
}

export function canSubmitForReview(status: Journey['status']): boolean {
    return status === 'working';
}

export function reviewPrimaryAction(journey: Pick<Journey, 'status' | 'head' | 'reviews'>, approvalRequired = true, allowCoordinatorApproval = false): 'approve' | 'integrate' | null {
    if (journey.status !== 'review')
        return null;
    return !approvalRequired || hasCurrentApproval(journey, allowCoordinatorApproval) ? 'integrate' : 'approve';
}

export function integrationReviewBlocker(journey: Pick<Journey, 'status' | 'head' | 'reviews'>, requireApproval = true, allowCoordinatorApproval = false): string | null {
    if (journey.status !== 'review')
        return 'Submit this revision for review before integrating.';
    if (journey.reviews.some(review => review.kind === 'request_changes' && !review.resolved))
        return 'Resolve outstanding change requests before integrating.';
    if (requireApproval && !hasCurrentApproval(journey, allowCoordinatorApproval))
        return 'Awaiting approval of this revision.';
    return null;
}
