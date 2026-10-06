import { insist, type Journey } from './core.ts';
import { patchSections } from '../patch-diff.ts';

/** Comments remain available throughout a journey; review decisions require submission. */
export type ReviewLineAnchor = { path: string; side: 'before' | 'after'; line: number; context: string };

export function validateReviewTarget(journey: Pick<Journey, 'status' | 'head' | 'changesets'>, input: { kind: unknown; revision: unknown; changeset?: unknown; patch?: unknown; anchor?: unknown }, snapshots?: { before: Record<string, string>; after: Record<string, string> }): ReviewLineAnchor | undefined {
    insist(['comment', 'request_changes', 'approve'].includes(input.kind as string), 'invalid_review', 'Unknown review action.', 400);
    insist(input.kind === 'comment' || journey.status === 'review', 'not_in_review', 'The journey must be submitted for review.');
    insist(input.revision === journey.head, 'stale_review', 'This review targets an old revision.');
    const changeset = input.changeset === undefined ? undefined : journey.changesets.find(c => c.id === input.changeset);
    if (input.changeset !== undefined)
        insist(changeset, 'changeset_not_found', 'Invalid review anchor.', 404);
    let patch: Journey['changesets'][number]['patches'][number] | undefined;
    if (input.patch !== undefined) {
        const owner = journey.changesets.find(c => c.patches.some(p => p.id === input.patch));
        insist(owner, 'patch_not_found', 'Invalid patch anchor.', 404);
        insist(!changeset || changeset.id === owner.id, 'invalid_review_anchor', 'The patch does not belong to this changeset.', 400);
        patch = owner.patches.find(p => p.id === input.patch);
    }
    if (input.anchor !== undefined) {
        insist(input.kind === 'comment', 'invalid_review_anchor', 'Line anchors are only valid for comments.', 400);
        insist(changeset && patch, 'invalid_review_anchor', 'A line comment must identify its changeset and patch.', 400);
        const anchor = input.anchor as Partial<ReviewLineAnchor> | null;
        insist(anchor && typeof anchor === 'object' && typeof anchor.path === 'string' && anchor.path.length > 0 && anchor.path.length <= 1000 && (anchor.side === 'before' || anchor.side === 'after') && Number.isSafeInteger(anchor.line) && anchor.line! > 0 && typeof anchor.context === 'string', 'invalid_line_anchor', 'Line comments require a path, side, positive line number, and line context.', 400);
        const change = patch.changes.find(item => item.path === anchor.path);
        insist(change, 'invalid_line_anchor', 'The file is not part of this patch.', 400);
        if (snapshots) {
            insist(anchor.side === 'before' ? Object.hasOwn(snapshots.before, anchor.path) : Object.hasOwn(snapshots.after, anchor.path), 'invalid_line_anchor', `The file does not exist on the ${anchor.side} side of this patch.`, 400);
            const sections = patchSections(snapshots.before[anchor.path] ?? '', snapshots.after[anchor.path] ?? '', change.hunks);
            const line = sections.flatMap(section => section.lines).find(item => item[anchor.side!] === anchor.line);
            insist(line, 'invalid_line_anchor', 'The line is not present in this patch diff.', 400);
            return { path: anchor.path, side: anchor.side!, line: anchor.line!, context: line.text.slice(0, 512) };
        }
        return { path: anchor.path, side: anchor.side!, line: anchor.line!, context: anchor.context };
    }
    return undefined;
}
