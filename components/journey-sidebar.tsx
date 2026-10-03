'use client';
import type { MouseEvent } from 'react';
import { Check } from 'lucide-react';
import type { Journey } from '@/lib/avc/core';

export function JourneySidebar({ journeys, selected, hrefForJourney, onNavigateJourney }: {
    journeys: Journey[];
    selected: string;
    hrefForJourney: (id: string) => string;
    onNavigateJourney: (event: MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
    const statusLabel = (status: string) => status === 'working' ? 'In progress' : status === 'review' ? 'In review' : status === 'integrated' ? 'Integrated' : 'Abandoned';
    return <div className="journey-list">{journeys.map((journey, index) => <a className={`journey-link ${selected === journey.id ? 'selected' : ''}`} style={{ textDecoration: 'none' }} key={journey.id} href={hrefForJourney(journey.id)} onClick={event => onNavigateJourney(event, journey.id)} aria-current={selected === journey.id ? 'page' : undefined}>
        <span className={`journey-number ${journey.status}`}>{journey.status === 'integrated' ? <Check size={14}/> : String(index + 1).padStart(2, '0')}</span><span><strong>{journey.title}</strong><small>{statusLabel(journey.status)}</small></span>
    </a>)}{!journeys.length && <p className="sidebar-empty">Your feature journeys will appear here.</p>}</div>;
}
