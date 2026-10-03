'use client';
import { useMemo } from 'react';
import { highlightCode, type SyntaxToken } from '@/lib/syntax-highlight';
import styles from './syntax-code.module.css';

/** A safe text-only token renderer shared by repository code and both diff layouts. */
export function SyntaxLine({ tokens }: { tokens: SyntaxToken[] }) {
    return <span className={styles.syntax}>{tokens.map((token, index) => <span key={index} className={token.classes.join(' ') || undefined}>{token.value}</span>)}</span>;
}

type SyntaxSourceProps = {
    path: string;
    source: string;
    editable?: boolean;
    onChange?: (value: string) => void;
};

export function SyntaxSource({ path, source, editable = false, onChange }: SyntaxSourceProps) {
    const highlighted = useMemo(() => highlightCode(path, source), [path, source]);
    return <div className={styles.source}>
        <div className={styles.language}>{highlighted.language ?? 'Plain text'}</div>
        <div className={styles.viewport}>
            <div className={styles.numbers} aria-hidden="true">{highlighted.lines.map((_, index) => <div key={index}>{index + 1}</div>)}</div>
            <div className={styles.content}>
                <pre className={styles.code} aria-hidden={editable || undefined} aria-label={editable ? undefined : `Read ${path}`} tabIndex={editable ? undefined : 0}><code>{highlighted.lines.map((tokens, index) => <span className={styles.line} key={index}><SyntaxLine tokens={tokens}/>{index < highlighted.lines.length - 1 ? '\n' : null}</span>)}</code></pre>
                {editable && <textarea className={styles.input} aria-label={`Edit ${path}`} value={source} onChange={event => onChange?.(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"/>}
            </div>
        </div>
    </div>;
}
