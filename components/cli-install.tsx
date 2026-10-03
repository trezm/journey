'use client';

import { useState, useSyncExternalStore } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

const subscribe = () => () => {};
const browserOrigin = () => window.location.origin;
const serverOrigin = () => '';

export function CliInstall() {
    const origin = useSyncExternalStore(subscribe, browserOrigin, serverOrigin);
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState(false);
    const command = origin ? `curl -fsSL '${origin}/install.sh' | bash -s -- --url '${origin}'` : '';

    async function copy() {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true); setCopyError(false);
        } catch { setCopyError(true); setCopied(false); }
    }

    return <div>
        <p>Run this once in your terminal. Requires Node.js 22+ and Git on macOS, Linux, or WSL.</p>
        <label className="small" htmlFor="journey-install-command">Install Journey CLI</label>
        <input id="journey-install-command" className="terminal" style={{ width: '100%' }} readOnly value={command}
            placeholder="Preparing install command…" spellCheck={false} onFocus={event => event.currentTarget.select()} />
        <div className="download-actions"><Button variant="outline" disabled={!command} onClick={copy}>
            {copied ? <Check /> : <Copy />}{copied ? 'Copied install command' : 'Copy install command'}
        </Button><a href="/install.sh" target="_blank" rel="noreferrer">View installer</a></div>
        {copyError && <p className="small" role="status">Select the command above and copy it manually.</p>}
        <p className="small">Installs to ~/.local/bin. Follow the installer’s PATH instructions if needed, then run <code>journey --help</code>. Rerun to update.</p>
    </div>;
}
