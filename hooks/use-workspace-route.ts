'use client';
import { useCallback, useSyncExternalStore } from 'react';
import { homeRoute, nextWorkspaceRoute, parseWorkspaceRoute, workspaceHref, WorkspaceNavigation, type WorkspaceRoute, type WorkspaceTab } from '@/lib/workspace-route';

let navigation: WorkspaceNavigation | undefined;
const store = () => navigation ??= new WorkspaceNavigation(window);
const subscribe = (listener: () => void) => store().subscribe(listener);
const snapshot = () => store().snapshot();
const serverSnapshot = () => '/';

export function useWorkspaceRoute() {
    const href = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
    const route = parseWorkspaceRoute(href) ?? homeRoute;
    const setProject = useCallback((value: string | ((current: string) => string)) => {
        const current = store().read();
        const project = typeof value === 'function' ? value(current.project) : value;
        if (project === current.project) return;
        store().navigate({ ...homeRoute, project }, !current.project);
    }, []);
    const setSelected = useCallback((journey: string) => {
        if (journey === store().read().journey) return;
        store().navigate({ journey, tab: journey ? 'changesets' : 'code', mode: journey ? 'journey' : 'repository', path: '' });
    }, []);
    const setTab = useCallback((tab: WorkspaceTab) => store().navigate({ tab, changeset: undefined }), []);
    const setModeChoice = useCallback(({ mode }: { project: string; mode: WorkspaceRoute['mode'] }) => store().navigate({ mode, tab: 'code', changeset: undefined }), []);
    const setPathChoice = useCallback(({ path }: { project: string; path: string }) => store().navigate({ path, tab: 'code' }), []);
    const hrefFor = (update: Partial<WorkspaceRoute>) => workspaceHref(nextWorkspaceRoute(route, update));
    const followLink = (event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, update: Partial<WorkspaceRoute>) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        store().navigate(update);
    };
    return {
        project: route.project, selected: route.journey, selectedChangeset: route.changeset ?? '', tab: route.tab,
        modeChoice: { project: route.project, mode: route.mode }, pathChoice: { project: route.project, path: route.path },
        setProject, setSelected, setTab, setModeChoice, setPathChoice, hrefFor, followLink,
    };
}
