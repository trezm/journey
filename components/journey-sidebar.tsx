'use client';
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { Journey } from '@/lib/avc/core';
import { journeyPage, type JourneyStatusFilter } from '@/lib/journey-list';
import styles from './journey-sidebar.module.css';

type Props = {
    journeys: Journey[];
    selected: string;
    hrefForJourney: (id: string) => string;
    onNavigateJourney: (event: MouseEvent<HTMLAnchorElement>, id: string) => void;
};

const statuses = { all: 'All statuses', working: 'In progress', review: 'In review', integrated: 'Integrated', abandoned: 'Abandoned' };

export function JourneySidebar({ journeys, selected, hrefForJourney, onNavigateJourney }: Props) {
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<JourneyStatusFilter>('all');
    const [page, setPage] = useState(1);
    const list = useRef<HTMLDivElement>(null);
    function changePage(next: number) { setPage(next); if (list.current) { list.current.scrollTop = 0; list.current.scrollLeft = 0; } }
    const result = useMemo(() => journeyPage(journeys, { query, status, page }), [journeys, query, status, page]);
    const filtered = !!query || status !== 'all';
    function reset() { setQuery(''); setStatus('all'); changePage(1); }
    return <div className={styles.sidebar}>
        <div className={styles.controls}>
            <div className={styles.search}><Search size={15} aria-hidden="true"/><input type="search" aria-label="Search journeys" placeholder="Search journeys" value={query} onChange={event => { setQuery(event.target.value); changePage(1); }}/></div>
            <select aria-label="Filter journeys by status" value={status} onChange={event => { setStatus(event.target.value as JourneyStatusFilter); changePage(1); }}>{Object.entries(statuses).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
        </div>
        <div className={styles.summary}><span>Newest first</span>{filtered && result.total > 0 && <button className={styles.reset} aria-label="Clear journey filters" onClick={reset}>Clear filters</button>}</div>
        <div className={styles.list} ref={list}>
            {result.items.map((journey, index) => <a href={hrefForJourney(journey.id)} className={`journey-link ${selected === journey.id ? 'selected' : ''}`} key={journey.id} aria-current={selected === journey.id ? 'page' : undefined} onClick={event => onNavigateJourney(event, journey.id)}>
                <span className={`journey-number ${journey.status}`} aria-hidden="true">{journey.status === 'integrated' ? <Check size={14}/> : String(result.start + index).padStart(2, '0')}</span>
                <span><strong>{journey.title}</strong><small>{statuses[journey.status]}</small></span>
            </a>)}
            {!result.total && <div className={styles.empty} role="status"><p>{journeys.length ? 'No journeys match these filters.' : 'Your feature journeys will appear here.'}</p>{filtered && <button className={styles.reset} aria-label="Clear journey filters" onClick={reset}>Clear filters</button>}</div>}
        </div>
        {!!result.total && <nav className={styles.pagination} aria-label="Journey pages">
            <button aria-label="Previous journey page" disabled={result.page === 1} onClick={() => changePage(result.page - 1)}><ChevronLeft size={14} aria-hidden="true"/>Prev</button>
            <span className={styles.range} role="status" aria-live="polite">{result.start}–{result.end} of {result.total}</span>
            <button aria-label="Next journey page" disabled={result.page === result.pageCount} onClick={() => changePage(result.page + 1)}>Next<ChevronRight size={14} aria-hidden="true"/></button>
        </nav>}
    </div>;
}
