import test from 'node:test';
import assert from 'node:assert/strict';
import { radialLockLayout, graphSpoke } from '../lib/lock-graph-layout.ts';
const graph = (owners, count) => ({ changesets: Array.from({length: owners}, (_, i) => ({id: `c${i}`})), files: Array.from({length: count}, (_, i) => ({path: `file-${i}.ts`})), edges: Array.from({length: count}, (_, i) => ({changeset: `c${i % owners}`, file: `file-${i}.ts`})) });
for (const [owners, count] of [[1,1], [1,2], [1,3], [2,16], [8,20], [70,1]]) {
    test(`${owners} hubs / ${count} files stay readable, nonoverlapping and in bounds`, () => {
        const input = graph(owners, count), layout = radialLockLayout(input);
        assert.deepEqual(layout, radialLockLayout(input));
        assert.equal(layout.files.size, count);
        assert.equal(layout.changesets.size, owners);
        const cards = [...layout.files.values(), ...layout.changesets.values()];
        for (const [index, a] of cards.entries()) {
            assert.ok(a.x >= a.width / 2 && a.y >= a.height / 2);
            assert.ok(a.x + a.width / 2 <= layout.width && a.y + a.height / 2 <= layout.height);
            for (const b of cards.slice(index + 1)) assert.ok(Math.abs(a.x-b.x) >= (a.width+b.width)/2+20 || Math.abs(a.y-b.y) >= (a.height+b.height)/2+20, 'Cards have a visible gap');
        }
        if (owners === 2 && count === 16) { assert.ok(layout.width < 1300); assert.ok(layout.height < 700); }
    });
}
test('shared files have a single identity and each spoke ends at the correct card boundary', () => {
    const input = graph(2,16); input.edges.push({changeset:'c1', file:'file-0.ts'});
    const layout = radialLockLayout(input);
    assert.equal(layout.files.size,16);
    const onBoundary = (x, y, card) => {
        const dx=Math.abs(x-card.x), dy=Math.abs(y-card.y), epsilon=1e-7;
        return dx <= card.width/2+epsilon && dy <= card.height/2+epsilon && (Math.abs(dx-card.width/2)<epsilon || Math.abs(dy-card.height/2)<epsilon);
    };
    for (const edge of input.edges) {
        const from=layout.changesets.get(edge.changeset), to=layout.files.get(edge.file);
        const [x1,y1,x2,y2]=graphSpoke(from,to).match(/-?\d+(?:\.\d+)?/g).map(Number);
        assert.ok(onBoundary(x1,y1,from)); assert.ok(onBoundary(x2,y2,to));
    }
});

test('exclusive ownership groups files on the side of their central hub', () => {
    const input = graph(2,16), layout = radialLockLayout(input);
    const midpoint = (layout.changesets.get('c0').y + layout.changesets.get('c1').y) / 2;
    for (const edge of input.edges) {
        const card = layout.files.get(edge.file);
        assert.ok(edge.changeset === 'c0' ? card.y < midpoint : card.y > midpoint);
    }
});
