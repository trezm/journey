import type { State, Journey, Files } from './avc/core';

export type CodeMode = 'repository' | 'journey';
export function repositorySelection(projects: { id: string }[], current: string, requested: string | null) {
    return projects.find(project => project.id === current)?.id
        ?? projects.find(project => project.id === requested)?.id
        ?? projects[0]?.id ?? '';
}
export function codeRevision(state: State | null, journey: Journey | undefined, mode: CodeMode) {
    return mode === 'journey' && journey ? journey.head : state?.head;
}
export function codePath(files: Files, selected: string) {
    if (selected && Object.hasOwn(files, selected)) return selected;
    return Object.hasOwn(files, 'README.md') ? 'README.md' : Object.keys(files).sort()[0] ?? '';
}

export type Resource<T> = {
    key: string;
    status: 'idle' | 'loading' | 'ready' | 'error';
    data?: T;
    error: string;
};

// A response belongs to both its repository/revision and its particular request.
// Abort alone is insufficient: a response may already have resolved when selection changes.
export class LatestResource<T> {
    private selected = '';
    private sequence = 0;
    private controller?: AbortController;
    private current: Resource<T> = { key: '', status: 'idle', error: '' };
    private fetchData: (key: string, signal: AbortSignal) => Promise<T>;
    private notify: (resource: Resource<T>) => void;

    constructor(fetchData: (key: string, signal: AbortSignal) => Promise<T>, notify: (resource: Resource<T>) => void) {
        this.fetchData = fetchData;
        this.notify = notify;
    }

    select(key: string) {
        this.controller?.abort();
        this.sequence++;
        this.selected = key;
        this.update({ key, status: key ? 'loading' : 'idle', error: '' });
    }

    private update(resource: Resource<T>) {
        this.current = resource;
        this.notify(resource);
    }

    async load(key = this.selected) {
        // Old action handlers must not reload a repository that is no longer selected.
        if (!key || key !== this.selected) return;
        this.controller?.abort();
        const controller = new AbortController(), sequence = ++this.sequence;
        this.controller = controller;
        this.update({ ...this.current, status: 'loading', error: '' });
        try {
            const data = await this.fetchData(key, controller.signal);
            if (key === this.selected && sequence === this.sequence)
                this.update({ key, status: 'ready', data, error: '' });
            return data;
        } catch (error) {
            if (key === this.selected && sequence === this.sequence)
                this.update({ key, status: 'error', error: error instanceof Error ? error.message : 'Unable to load repository.' });
        }
    }
}
