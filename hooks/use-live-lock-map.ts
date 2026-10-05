'use client';
import { useCallback, useEffect, useState } from 'react';
import { jsonFetch } from '@/lib/avc/client';
import type { LiveSnapshot } from '@/lib/avc/live';
import { LiveResource, type LiveResourceState } from '@/lib/live-resource';

export function useLiveLockMap(project: string) {
    const [paused, setPaused] = useState(false);
    const [resource, setResource] = useState<LiveResourceState<LiveSnapshot>>({ key: '', loading: false, running: false, error: '' });
    const [loader] = useState(() => new LiveResource<LiveSnapshot>(
        (key, signal) => jsonFetch(`/api/avc?project=${encodeURIComponent(key)}&live=1`, { signal, cache: 'no-store' }),
        setResource,
    ));
    useEffect(() => {
        loader.select(project);
        return () => loader.select('');
    }, [loader, project]);
    useEffect(() => {
        const update = () => loader.setRunning(!paused && document.visibilityState !== 'hidden');
        update();
        document.addEventListener('visibilitychange', update);
        return () => { document.removeEventListener('visibilitychange', update); loader.setRunning(false); };
    }, [loader, paused]);
    const refresh = useCallback(() => loader.refresh(project), [loader, project]);
    const visible = resource.key === project ? resource : { key: project, loading: true, running: false, error: '' };
    return { ...visible, paused, setPaused, refresh };
}
