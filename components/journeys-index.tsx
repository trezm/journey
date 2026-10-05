'use client';
import { useMemo, useState, type MouseEvent } from 'react';
import { GitBranch, Search } from 'lucide-react';
import type { Journey } from '@/lib/avc/core';
import { journeyPage, type JourneyStatusFilter } from '@/lib/journey-list';
const statuses = { all: 'All statuses', working: 'In progress', review: 'In review', integrated: 'Integrated', abandoned: 'Abandoned' };
type Props = { journeys: Journey[]; hrefForJourney: (id: string) => string; onNavigateJourney: (event: MouseEvent<HTMLAnchorElement>, id: string) => void };
export function JourneysIndex({ journeys, hrefForJourney, onNavigateJourney }: Props) {
    const [query, setQuery] = useState(''), [status, setStatus] = useState<JourneyStatusFilter>('all'), [page, setPage] = useState(1);
    const result = useMemo(() => journeyPage(journeys, { query, status, page }), [journeys, query, status, page]);
    return <section className="journeys-index" aria-label="Repository journeys">
        <div className="section-heading"><div><h2>Journeys</h2><p>Implementation, review, and integrated work.</p></div><span className="chip">{journeys.length} total</span></div>
        <div className="journeys-filters"><label><Search size={17}/><input aria-label="Search journeys" type="search" placeholder="Search journeys" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/></label><select aria-label="Filter journeys by status" value={status} onChange={e => { setStatus(e.target.value as JourneyStatusFilter); setPage(1); }}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="journeys-rows">{result.items.map(journey => <a key={journey.id} className="journeys-row" href={hrefForJourney(journey.id)} onClick={event => onNavigateJourney(event, journey.id)}><GitBranch size={20}/><div><h3>{journey.title}</h3>{journey.description && <p>{journey.description}</p>}<small>{journey.changesets.length} changesets · {journey.changesets.reduce((n, c) => n + c.patches.length, 0)} patches · {new Date(journey.created).toLocaleDateString()}</small></div><span className={`status ${journey.status}`}>{statuses[journey.status]}</span></a>)}</div>
        {!result.total && <div className="empty-panel compact"><GitBranch size={28}/><h3>{journeys.length ? 'No matching journeys' : 'No journeys yet'}</h3><p>{journeys.length ? 'Try another search or status.' : 'Start a journey to build a feature.'}</p></div>}
        {!!result.total && <nav className="journeys-pagination" aria-label="Journey pages"><button disabled={result.page === 1} onClick={() => setPage(result.page - 1)}>Previous</button><span role="status">{result.start}–{result.end} of {result.total}</span><button disabled={result.page === result.pageCount} onClick={() => setPage(result.page + 1)}>Next</button></nav>}
    </section>;
}
