'use client';
import { useCallback, useEffect, useState } from 'react';
import type { RepositorySummary } from '@/lib/avc/repository-visibility';
import type { State, Files } from '@/lib/avc/core';
import { LatestResource, type Resource } from '@/lib/repository-code';
import { jsonFetch } from '@/lib/avc/client';

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
    return await jsonFetch(url, { signal, cache: 'no-store' }) as T;
}
const fetchRepository = (project: string, signal: AbortSignal) => fetchJson<{ state: State; project: RepositorySummary }>(`/api/avc?project=${encodeURIComponent(project)}`, signal);
const EMPTY_FILES: Files = Object.freeze({});
const fetchFiles = (key: string, signal: AbortSignal) => {
    const [project, revision] = key.split(':');
    return fetchJson<{ revision: string; files: Files }>(`/api/avc?project=${encodeURIComponent(project)}&revision=${encodeURIComponent(revision)}`, signal);
};

function useResource<T>(key: string, fetchData: (key: string, signal: AbortSignal) => Promise<T>) {
    const [resource, setResource] = useState<Resource<T>>({ key: '', status: 'idle', error: '' });
    const [loader] = useState(() => new LatestResource(fetchData, setResource));
    useEffect(() => {
        loader.select(key);
        void loader.load();
        return () => loader.select('');
    }, [key, loader]);
    const reload = useCallback((id = key) => loader.load(id), [key, loader]);
    const clear = useCallback(() => loader.select(''), [loader]);
    // Hide the previous repository immediately, before the new selection's effect runs.
    const visible = resource.key === key ? resource : { key, status: key ? 'loading' as const : 'idle' as const, error: '' };
    return { ...visible, reload, clear };
}

export function useRepository(project: string) {
    const resource = useResource(project, fetchRepository);
    const { clear } = resource;
    const setState = useCallback((value: null) => { if (value === null) clear(); }, [clear]);
    return { ...resource, state: resource.data?.state ?? null, repository: resource.data?.project ?? null, setState };
}

export function useRepositoryFiles(project: string, revision: string | undefined) {
    const resource = useResource(project && revision ? `${project}:${revision}` : '', fetchFiles);
    return { ...resource, files: resource.data?.files ?? EMPTY_FILES };
}
