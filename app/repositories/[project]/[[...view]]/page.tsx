import { notFound } from 'next/navigation';
import Workspace from '@/app/page';
import RepositorySettings from '@/app/settings/page';
import { parseWorkspaceRoute } from '@/lib/workspace-route';

export default async function RepositoryPage({ params }: { params: Promise<{ project: string; view?: string[] }> }) {
    const { project, view = [] } = await params;
    const route = parseWorkspaceRoute('/repositories/' + [project, ...view].map(encodeURIComponent).join('/'));
    if (!route) notFound();
    return route.settings ? <RepositorySettings/> : <Workspace/>;
}
