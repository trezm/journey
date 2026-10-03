import { type Files, type Journey, type State, checkTokens, diff, insist, leaseActive, mergeFiles, remap, touches } from './core.ts';

// Posting and integration both preserve exclusive scopes for the complete immutable candidate.
export function integrationFiles(s: State, j: Journey, canonical: Files, base: Files, ours: Files, tokens: string[], now = Date.now()): Files {
    const held = checkTokens(s, j, tokens, now);
    for (const path of new Set([...Object.keys(base), ...Object.keys(ours)])) {
        if (base[path] === ours[path])
            continue;
        if (Object.hasOwn(base, path) !== Object.hasOwn(ours, path))
            insist(held.some(l => l.path === path && l.whole), 'whole_file_required', 'Creating or deleting files requires current whole-file leases.');
        const changes = diff(base[path] ?? '', ours[path] ?? '');
        const other = diff(base[path] ?? '', canonical[path] ?? '');
        for (const h of changes) {
            const [start, end] = remap(h.start, h.start + h.count, other);
            insist(held.some(l => l.path === path && (l.whole || (start >= l.canonicalStart && end <= l.canonicalEnd))), 'lock_coverage', `Final changes to ${path} are not covered by current leases.`);
        }
    }
    const merged = mergeFiles(base, ours, canonical);
    for (const path of new Set([...Object.keys(canonical), ...Object.keys(merged)])) {
        if (canonical[path] === merged[path])
            continue;
        const existenceChanged = Object.hasOwn(canonical, path) !== Object.hasOwn(merged, path);
        const changes = diff(canonical[path] ?? '', merged[path] ?? '');
        const conflict = s.leases.find(l => l.journey !== j.id && leaseActive(l, now) && l.path === path &&
            (existenceChanged || l.whole || changes.some(h => touches(l.canonicalStart, l.canonicalEnd, h))));
        insist(!conflict, 'integration_lock_conflict', `Another journey holds an active lock on the changes to ${path}. Wait for it to finish or release its lock.`, 409,
            conflict ? { path, journey: conflict.journey, lockId: conflict.id } : undefined);
    }
    return merged;
}
