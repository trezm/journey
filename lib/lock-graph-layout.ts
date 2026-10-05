export type GraphCard = { x: number; y: number; width: number; height: number };
type GraphShape = { files: { path: string }[]; changesets: { id: string }[]; edges: { file: string; changeset: string }[] };
const WIDTH = 256, HEIGHT = 56, GAP = 24;

/** A rounded orbit keeps wide labels readable without the crowding at an ellipse's poles. */
export function radialLockLayout(graph: GraphShape) {
    const changesets = new Map<string, GraphCard>();
    const files = new Map<string, GraphCard>();
    const columns = Math.max(1, Math.ceil(Math.sqrt(graph.changesets.length / 3)));
    const rows = Math.ceil(graph.changesets.length / columns);
    const innerWidth = columns * (WIDTH + GAP) - GAP;
    const innerHeight = Math.max(HEIGHT, rows * (HEIGHT + GAP) - GAP);
    graph.changesets.forEach((change, index) => {
        const row = Math.floor(index / columns), col = index % columns;
        const rowCount = Math.min(columns, graph.changesets.length - row * columns);
        changesets.set(change.id, { x: (col - (rowCount - 1) / 2) * (WIDTH + GAP), y: (row - (rows - 1) / 2) * (HEIGHT + GAP), width: WIDTH, height: HEIGHT });
    });
    const count = graph.files.length;
    const cap = count >= 8 ? 2 : count >= 3 ? 1 : 0;
    const sideCount = Math.ceil((count - cap * 2) / 2);
    const radiusY = Math.max(innerHeight / 2 + HEIGHT + GAP * 2, (sideCount + 1) * (HEIGHT + GAP) / 2);
    const radiusX = innerWidth / 2 + WIDTH + GAP * 2;
    const slots: { x: number; y: number }[] = [];
    // Clockwise order, with bounded vertical spacing and curved sides around the hubs.
    for (let index = 0; index < cap; index++) slots.push({ x: (index - (cap - 1) / 2) * (WIDTH + GAP), y: -radiusY });
    const right = Math.ceil((count - cap * 2) / 2), left = count - cap * 2 - right;
    for (let index = 0; index < right; index++) {
        const y = (index - (right - 1) / 2) * (HEIGHT + GAP);
        slots.push({ x: radiusX + GAP * 2 * Math.sqrt(Math.max(0, 1 - (y / radiusY) ** 2)), y });
    }
    for (let index = cap - 1; index >= 0; index--) slots.push({ x: (index - (cap - 1) / 2) * (WIDTH + GAP), y: radiusY });
    for (let index = left - 1; index >= 0; index--) {
        const y = (index - (left - 1) / 2) * (HEIGHT + GAP);
        slots.push({ x: -radiusX - GAP * 2 * Math.sqrt(Math.max(0, 1 - (y / radiusY) ** 2)), y });
    }
    const owners = new Map<string, GraphCard[]>();
    for (const edge of graph.edges) {
        const hub = changesets.get(edge.changeset);
        if (hub) owners.set(edge.file, [...(owners.get(edge.file) ?? []), hub]);
    }
    // Keep each owner's files together around its direction. Shared ownership uses
    // the owners' centroid, so one file sits between its hubs rather than duplicating.
    const orderedFiles = graph.files.map((file, index) => {
        const hubs = owners.get(file.path) ?? [];
        const x = hubs.reduce((sum, hub) => sum + hub.x, 0);
        const y = hubs.reduce((sum, hub) => sum + hub.y, 0);
        return { file, index, hubs, angle: Math.atan2(y, x) };
    }).sort((a, b) => a.angle - b.angle || a.index - b.index);
    slots.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
    // Rotate the whole grouping to minimize spoke distance without scattering groups.
    let bestOffset = 0, bestCost = Infinity;
    for (let offset = 0; offset < count; offset++) {
        const cost = orderedFiles.reduce((sum, item, index) => {
            const slot = slots[(index + offset) % count];
            return sum + item.hubs.reduce((distance, hub) => distance + (slot.x - hub.x) ** 2 + (slot.y - hub.y) ** 2, 0);
        }, 0);
        if (cost < bestCost) { bestCost = cost; bestOffset = offset; }
    }
    orderedFiles.forEach((item, index) => files.set(item.file.path, { ...slots[(index + bestOffset) % count], width: WIDTH, height: HEIGHT }));
    const cards = [...changesets.values(), ...files.values()];
    const minX = Math.min(0, ...cards.map(card => card.x - card.width / 2)) - GAP;
    const minY = Math.min(0, ...cards.map(card => card.y - card.height / 2)) - GAP;
    const width = Math.max(320, Math.max(0, ...cards.map(card => card.x + card.width / 2)) + GAP - minX);
    const height = Math.max(200, Math.max(0, ...cards.map(card => card.y + card.height / 2)) + GAP - minY);
    for (const card of cards) { card.x -= minX; card.y -= minY; }
    return { changesets, files, width, height };
}

/** Clip the spoke to both card boundaries, so pulses never travel beneath labels. */
export function graphSpoke(from: GraphCard, to: GraphCard) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const boundary = (card: GraphCard) => Math.min(dx ? card.width / 2 / Math.abs(dx) : Infinity, dy ? card.height / 2 / Math.abs(dy) : Infinity);
    const start = boundary(from), end = boundary(to);
    return `M ${from.x + dx * start} ${from.y + dy * start} L ${to.x - dx * end} ${to.y - dy * end}`;
}
