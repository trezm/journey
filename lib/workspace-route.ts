export type WorkspaceTab = 'journeys' | 'changesets' | 'code' | 'live' | 'locks' | 'inbox' | 'review' | 'agents' | 'recording';
export type WorkspaceRoute = {
    project: string;
    journey: string;
    tab: WorkspaceTab;
    mode: 'repository' | 'journey';
    path: string;
    settings?: boolean;
    changeset?: string;
};
export const homeRoute: WorkspaceRoute = { project: '', journey: '', tab: 'code', mode: 'repository', path: '' };
const tabs: readonly string[] = ['changesets', 'code', 'live', 'locks', 'inbox', 'review', 'agents', 'recording'];

/** Route IDs are opaque, encoded path segments; file names belong in the query. */
export function parseWorkspaceRoute(href: string): WorkspaceRoute | null {
    const url = new URL(href, 'https://journey.local');
    let parts: string[];
    try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
    catch { return null; }
    if (!parts.length || (parts.length === 1 && parts[0] === 'settings')) {
        return { ...homeRoute, project: url.searchParams.get('project') ?? '', settings: parts[0] === 'settings', path: url.searchParams.get('file') ?? '' };
    }
    if (parts[0] !== 'repositories' || !parts[1]) return null;
    const route: WorkspaceRoute = { ...homeRoute, project: parts[1], path: url.searchParams.get('file') ?? '' };
    let view = parts.slice(2);
    if (view[0] === 'journeys') {
        if (!view[1]) return { ...route, tab: 'journeys' };
        route.journey = view[1];
        route.mode = url.searchParams.get('mode') === 'repository' ? 'repository' : 'journey';
        route.tab = 'changesets';
        view = view.slice(2);
    }
    if (route.journey && view[0] === 'changesets' && view.length === 2 && view[1]) return { ...route, changeset: view[1] };
    if (view.length > 1) return null;
    if (view[0] === 'settings' && !route.journey) route.settings = true;
    else if (view[0]) {
        if (!tabs.includes(view[0])) return null;
        route.tab = view[0] as WorkspaceTab;
    }
    return route;
}

export function workspaceHref(route: WorkspaceRoute): string {
    if (!route.project) return '/';
    let path = `/repositories/${encodeURIComponent(route.project)}`;
    if (route.settings) return `${path}/settings`;
    if (route.tab === 'journeys') return `${path}/journeys`;
    if (route.journey) path += `/journeys/${encodeURIComponent(route.journey)}`;
    if (route.journey && route.changeset && route.tab === 'changesets') return `${path}/changesets/${encodeURIComponent(route.changeset)}`;
    if (route.tab !== (route.journey ? 'changesets' : 'code')) path += `/${route.tab}`;
    const query = new URLSearchParams();
    if (route.journey && route.mode === 'repository' && route.tab === 'code') query.set('mode', 'repository');
    if (route.path && route.tab === 'code') query.set('file', route.path);
    return `${path}${query.size ? `?${query}` : ''}`;
}

type HistoryHost = {
    location: { pathname: string; search: string };
    history: { state: unknown; pushState: (data: unknown, unused: string, url: string) => void; replaceState: (data: unknown, unused: string, url: string) => void };
    addEventListener: (name: string, listener: () => void) => void;
    removeEventListener: (name: string, listener: () => void) => void;
};

/** The URL is the navigation state, including on refresh and browser Back/Forward. */
export class WorkspaceNavigation {
    private host: HistoryHost;
    private listeners = new Set<() => void>();
    constructor(host: HistoryHost) { this.host = host; }
    snapshot = () => this.host.location.pathname + this.host.location.search;
    read = () => parseWorkspaceRoute(this.snapshot()) ?? homeRoute;
    private emit = () => { for (const listener of this.listeners) listener(); };
    subscribe = (listener: () => void) => {
        if (!this.listeners.size) this.host.addEventListener('popstate', this.emit);
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
            if (!this.listeners.size) this.host.removeEventListener('popstate', this.emit);
        };
    };
    navigate = (update: Partial<WorkspaceRoute>, replace = false) => {
        const next = workspaceHref(nextWorkspaceRoute(this.read(), update));
        if (next === this.snapshot()) return;
        // Preserve framework history metadata so client navigation and Back agree.
        this.host.history[replace ? 'replaceState' : 'pushState'](this.host.history.state, '', next);
        this.emit();
    };
}

/** Leaving a detail scope must never carry its selected changeset into another page. */
export function nextWorkspaceRoute(current: WorkspaceRoute, update: Partial<WorkspaceRoute>): WorkspaceRoute {
    const leaving = ['project', 'journey', 'tab', 'mode'].some(key => key in update && update[key as keyof WorkspaceRoute] !== current[key as keyof WorkspaceRoute]);
    return { ...current, settings: false, ...(leaving ? { changeset: undefined } : {}), ...update };
}
