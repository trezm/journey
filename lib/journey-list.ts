import type { Journey } from './avc/core.ts';

export type JourneyStatusFilter = 'all' | Journey['status'];
export type JourneyListItem = Pick<Journey, 'id' | 'title' | 'description' | 'status' | 'created'>;
export const JOURNEYS_PER_PAGE = 10;

/** Filter and sort a copy; repository metadata keeps its canonical ordering. */
export function journeyPage<T extends JourneyListItem>(journeys: readonly T[], options: { query: string; status: JourneyStatusFilter; page: number }) {
    const query = options.query.trim().toLowerCase();
    const matching = journeys.filter(journey =>
        (options.status === 'all' || journey.status === options.status) &&
        (!query || `${journey.title}\n${journey.description}`.toLowerCase().includes(query))
    ).sort((a, b) => b.created - a.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const size = JOURNEYS_PER_PAGE;
    const pageCount = Math.max(1, Math.ceil(matching.length / size));
    const page = Math.min(pageCount, Math.max(1, Number.isFinite(options.page) ? Math.floor(options.page) : 1));
    const offset = (page - 1) * size;
    return {
        items: matching.slice(offset, offset + size), total: matching.length, page, pageCount,
        start: matching.length ? offset + 1 : 0, end: Math.min(offset + size, matching.length),
    };
}
