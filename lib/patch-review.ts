import type { Patch } from './avc/core';

type ReviewStorage = Pick<Storage, 'getItem' | 'setItem'>;
const EMPTY_VIEWED: readonly string[] = Object.freeze([]);

export function patchReviewKey(project: string, patch: Pick<Patch, 'id' | 'before' | 'after'>) {
    return `journey:patch-viewed:v1:${JSON.stringify([project, patch.id, patch.before, patch.after])}`;
}

/** Each immutable patch owns a list of reviewed paths, local to this browser. */
export class PatchReview {
    private key: string;
    private storage: () => ReviewStorage;
    private viewed: readonly string[] | undefined;
    private listeners = new Set<() => void>();

    constructor(key: string, storage: () => ReviewStorage) {
        this.key = key;
        this.storage = storage;
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    serverSnapshot = () => EMPTY_VIEWED;

    snapshot = (): readonly string[] => {
        if (this.viewed !== undefined) return this.viewed;
        try {
            const value: unknown = JSON.parse(this.storage().getItem(this.key) ?? '[]');
            this.viewed = Array.isArray(value) && value.every(path => typeof path === 'string')
                ? Object.freeze([...new Set<string>(value)]) : EMPTY_VIEWED;
        } catch {
            this.viewed = EMPTY_VIEWED;
        }
        return this.viewed;
    };

    setViewed(path: string, viewed: boolean) {
        const paths = new Set(this.snapshot());
        if (paths.has(path) === viewed) return;
        if (viewed) paths.add(path); else paths.delete(path);
        this.viewed = Object.freeze([...paths]);
        try {
            this.storage().setItem(this.key, JSON.stringify(this.viewed));
        } catch {
            // Keep review controls usable when browser storage is blocked or full.
        }
        for (const listener of this.listeners) listener();
    }
}
