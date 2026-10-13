/** Share a credential-free endpoint, never a token or browser session. */
export function repositoryCloneUrl(origin: string, project: string): string {
    if (!origin || !project) return '';
    const base = new URL(origin);
    if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Unsupported Git URL protocol.');
    return `${base.origin}/api/git/${encodeURIComponent(project)}/`;
}
export function repositoryCloneCommand(url: string, isPublic: boolean): string {
    if (!url) return '';
    const quoted = `'${url.replaceAll("'", "'\\''")}'`;
    return `git ${isPublic ? '' : '-c credential.username=journey '}clone ${quoted}`;
}
export async function copyCloneText(value: string, clipboard: Pick<Clipboard, 'writeText'> | undefined): Promise<boolean> {
    try { if (!clipboard) return false; await clipboard.writeText(value); return true; }
    catch { return false; }
}
