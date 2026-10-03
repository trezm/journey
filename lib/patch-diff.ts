import type { Hunk } from './avc/core.ts';

export type DiffLine = {
    kind: 'context' | 'removed' | 'added';
    text: string;
    before?: number;
    after?: number;
};
export type SplitRow = { before?: DiffLine; after?: DiffLine };
export type DiffSection = {
    beforeStart: number;
    beforeCount: number;
    afterStart: number;
    afterCount: number;
    lines: DiffLine[];
    rows: SplitRow[];
};

function fileLines(text: string) {
    if (!text) return [];
    const result = text.split('\n');
    // A final newline terminates the last line; it is not another displayed line.
    if (text.endsWith('\n')) result.pop();
    return result;
}

export function splitRows(lines: DiffLine[]): SplitRow[] {
    const rows: SplitRow[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (line.kind === 'context') { rows.push({ before: line, after: line }); index++; continue; }
        const removed: DiffLine[] = [], added: DiffLine[] = [];
        while (index < lines.length && lines[index].kind !== 'context') {
            const changed = lines[index++];
            (changed.kind === 'removed' ? removed : added).push(changed);
        }
        for (let i = 0; i < Math.max(removed.length, added.length); i++)
            rows.push({ before: removed[i], after: added[i] });
    }
    return rows;
}

// Recorded hunks are anchored to this patch's before revision. Read actual text
// from both immutable snapshots, never from a journey's subsequently edited head.
export function patchSections(before: string, after: string, hunks: Hunk[], context = 3): DiffSection[] {
    const oldLines = fileLines(before), newLines = fileLines(after);
    const oldProtocolLength = oldLines.length + (before.endsWith('\n') ? 1 : 0);
    let shift = 0;
    const edits = hunks.map(hunk => {
        const edit = { ...hunk, afterStart: hunk.start + shift };
        shift += hunk.lines.length - hunk.count;
        return edit;
    });
    const groups: { start: number; end: number; afterStart: number; edits: typeof edits }[] = [];
    for (const edit of edits) {
        const start = Math.max(0, edit.start - context), end = Math.min(oldProtocolLength, edit.start + edit.count + context);
        const previous = groups.at(-1);
        if (previous && start <= previous.end) {
            previous.end = Math.max(previous.end, end);
            previous.edits.push(edit);
        } else groups.push({ start, end, afterStart: Math.max(0, edit.afterStart - (edit.start - start)), edits: [edit] });
    }
    return groups.map(group => {
        const lines: DiffLine[] = [];
        let oldIndex = group.start, newIndex = group.afterStart;
        const appendContext = (until: number) => {
            while (oldIndex < until) {
                if (oldIndex < oldLines.length && newIndex < newLines.length)
                    lines.push({ kind: 'context', text: oldLines[oldIndex], before: oldIndex + 1, after: newIndex + 1 });
                else if (oldIndex < oldLines.length)
                    lines.push({ kind: 'removed', text: oldLines[oldIndex], before: oldIndex + 1 });
                else if (newIndex < newLines.length)
                    lines.push({ kind: 'added', text: newLines[newIndex], after: newIndex + 1 });
                oldIndex++; newIndex++;
            }
        };
        for (const edit of group.edits) {
            appendContext(edit.start);
            for (let i = 0; i < edit.count; i++) {
                if (oldIndex < oldLines.length) lines.push({ kind: 'removed', text: oldLines[oldIndex], before: oldIndex + 1 });
                oldIndex++;
            }
            for (let i = 0; i < edit.lines.length; i++) {
                if (newIndex < newLines.length) lines.push({ kind: 'added', text: newLines[newIndex], after: newIndex + 1 });
                newIndex++;
            }
        }
        appendContext(group.end);
        const oldNumbers = lines.flatMap(line => line.before === undefined ? [] : [line.before]);
        const newNumbers = lines.flatMap(line => line.after === undefined ? [] : [line.after]);
        return {
            beforeStart: oldNumbers[0] ?? group.start,
            beforeCount: oldNumbers.length,
            afterStart: newNumbers[0] ?? group.afterStart,
            afterCount: newNumbers.length,
            lines, rows: splitRows(lines),
        };
    });
}

export function patchFileStatus(before: string | undefined, after: string | undefined) {
    if (before === undefined) return 'Added file';
    if (after === undefined) return 'Deleted file';
    return 'Modified file';
}
