'use client';
import type { MouseEvent } from 'react';
import { Activity, Code2, GitBranch, Layers, ShieldCheck, Terminal } from 'lucide-react';
import type { WorkspaceRoute, WorkspaceTab } from '@/lib/workspace-route';
type Props = {
    selected: string;
    tab: WorkspaceTab;
    hrefFor: (update: Partial<WorkspaceRoute>) => string;
    followLink: (event: MouseEvent<HTMLAnchorElement>, update: Partial<WorkspaceRoute>) => void;
};
export function RepositoryNavigation({ selected, tab, hrefFor, followLink }: Props) {
    const journeys = !!selected || tab === 'journeys';
    const link = (label: string, target: Partial<WorkspaceRoute>, active: boolean, icon: React.ReactNode) => <a href={hrefFor(target)} onClick={event => followLink(event, target)} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>{icon}{label}</a>;
    return <>
        <nav className="repository-primary" aria-label="Repository navigation">
            {link('Code', { journey: '', changeset: undefined, tab: 'code', mode: 'repository', path: '' }, !journeys && (tab === 'code' || tab === 'live'), <Code2 size={17}/>)}
            {link('Journeys', { journey: '', changeset: undefined, tab: 'journeys', mode: 'repository', path: '' }, journeys, <GitBranch size={17}/>)}
            {link('Connect & import', { journey: '', changeset: undefined, tab: 'agents', mode: 'repository', path: '' }, tab === 'agents', <Terminal size={17}/>)}
            <a href={hrefFor({ settings: true })}><ShieldCheck size={17}/>Settings</a>
        </nav>
        {!selected && (tab === 'code' || tab === 'live') && <nav className="repository-view-toggle" aria-label="Code views">
            {link('Source tree', { tab: 'code', mode: 'repository' }, tab === 'code', <Layers size={16}/>)}
            {link('Live map', { tab: 'live', mode: 'repository' }, tab === 'live', <Activity size={16}/>)}
        </nav>}
    </>;
}
