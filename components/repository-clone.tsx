'use client';
import { useId, useState } from 'react';
import { Check, ChevronDown, Copy, Download } from 'lucide-react';
import { repositoryCloneUrl, repositoryCloneCommand, copyCloneText } from '@/lib/repository-clone';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import styles from './repository-clone.module.css';

export function RepositoryClone({ project, isPublic, onCredentials }: { project: string; isPublic: boolean; onCredentials?: () => void }) {
    const id = useId();
    const [open, setOpen] = useState(false);
    const [url, setUrl] = useState(''), [copied, setCopied] = useState(''), [error, setError] = useState('');
    const command = repositoryCloneCommand(url, isPublic);
    async function copy(value: string, label: string) {
        setCopied(''); setError('');
        if (await copyCloneText(value, navigator.clipboard)) setCopied(label);
        else setError('Clipboard unavailable. Select the URL or command below and copy it manually.');
    }
    return <Popover open={open} onOpenChange={open => {
        setOpen(open);
        setCopied(''); setError('');
        if (open) setUrl(repositoryCloneUrl(window.location.origin, project));
    }}>
        <PopoverTrigger asChild><Button variant="outline"><Download size={16}/>Clone repo<ChevronDown size={14}/></Button></PopoverTrigger>
        <PopoverContent align="end" className={styles.menu} aria-labelledby={`${id}-title`}>
            <h2 id={`${id}-title`}>Clone with Git</h2><p className={styles.protocol}>HTTPS</p>
            <label htmlFor={`${id}-url`}>Repository URL</label>
            <div className={styles.row}><input id={`${id}-url`} readOnly value={url} onFocus={event => event.currentTarget.select()}/><Button variant="outline" disabled={!url} aria-label="Copy repository URL" onClick={() => void copy(url, 'URL')}>{copied === 'URL' ? <Check/> : <Copy/>}</Button></div>
            <label htmlFor={`${id}-command`}>Terminal command</label>
            <textarea id={`${id}-command`} readOnly value={command} rows={3} onFocus={event => event.currentTarget.select()}/>
            <Button variant="outline" disabled={!url} onClick={() => void copy(command, 'Command')}>{copied === 'Command' ? <Check/> : <Copy/>}Copy clone command</Button>
            {isPublic ? <p>No sign-in required. Clone accepted history from main.</p> : <><p>When Git asks for a password, enter a repository agent token from Connect &amp; import. Your account password will not work.</p>{onCredentials && <Button variant="ghost" onClick={() => { setOpen(false); onCredentials(); }}>Open Connect &amp; import</Button>}</>}
            <p>This URL supports cloning and fetching. Publish changes through Journey or your linked Git provider.</p>
            <div className={styles.feedback} role={error ? 'alert' : 'status'} aria-live="polite">{error || (copied ? `${copied} copied.` : '')}</div>
        </PopoverContent>
    </Popover>;
}
