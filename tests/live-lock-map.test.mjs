import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as routes from '../lib/workspace-route.ts';

const nodeText = node => Array.isArray(node) ? node.map(nodeText).join(' ') : React.isValidElement(node) ? nodeText(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const region = (start, end, status, waitingIds = []) => ({ start, end, status, waitingIds, lockIds: ['lock'], changesetIds: ['c1', ...waitingIds], approximate: false });
const snapshot = {
    head: 'abcdef012345', sequence: 14, updatedAt: 100,
    files: [{ path: 'src/main.ts', lineCount: 120, exists: true, regions: [region(3, 4, 'locked'), region(5, 6, 'waiting', ['c2']), region(7, 8, 'contended', ['c2', 'c3'])] }, { path: 'src/new.ts', lineCount: 1, exists: false, regions: [region(1, 1, 'locked')] }],
    changesets: [
        { id: 'c1', journey: 'j1', title: 'Add parser', description: 'Share the parsing helpers', paths: ['src/main.ts', 'src/new.ts'], status: 'working', lockCount: 2, waitingCount: 0, patchCount: 1 },
        { id: 'c2', journey: 'j2', title: 'Improve errors', description: 'Handle invalid input', paths: ['src/main.ts'], status: 'review', lockCount: 0, waitingCount: 1, patchCount: 0 },
        { id: 'c3', journey: 'j3', title: 'Earlier work', description: 'Completed parsing work', paths: ['src/main.ts'], status: 'integrated', lockCount: 0, waitingCount: 0, patchCount: 4 },
    ], summary: { fileCount: 2, lockedRegions: 4, waitingCount: 2, contendedRegions: 1 },
};
function render(options = {}) {
    const require = createRequire(import.meta.url);
    const code = ts.transpileModule(readFileSync(new URL('../components/live-lock-map.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    let stateIndex = 0;
    const initial = ['', false, false, 0, 0, options.selection ?? {}];
    const mockRequire = name => {
        if (name === 'react') return { ...React, useEffect: () => {}, useState: value => { const index = stateIndex++; return [index < initial.length ? initial[index] : value, next => options.onState?.(index, next)]; } };
        if (name === 'react/jsx-runtime') {
            const runtime = require(name);
            const wrap = fn => (type, props, ...rest) => { if (type === 'button') options.onButton?.(props); return fn(type, props, ...rest); };
            return { ...runtime, jsx: wrap(runtime.jsx), jsxs: wrap(runtime.jsxs) };
        }
        if (name === '@/hooks/use-live-lock-map') return { useLiveLockMap: () => ({ key: 'repo', data: options.snapshot ?? snapshot, running: true, loading: false, paused: false, receivedAt: 100, error: '', refresh: async () => {}, setPaused: () => {}, ...options.live }) };
        if (name === '@/lib/workspace-route') return routes;
        if (name === './live-lock-map.module.css') return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        return require(name);
    };
    runInNewContext(code, { module, exports: module.exports, require: mockRequire, Date });
    if (options.exportsOnly) return module.exports;
    return renderToStaticMarkup(React.createElement(module.exports.LiveLockMap, { project: 'repo' }));
}

test('the map shows distinct color states, request counts, new files, and active changeset connections', () => {
    const html = render();
    assert.match(html, /class="band locked /); assert.match(html, /class="band waiting /); assert.match(html, /class="band contended /);
    assert.match(html, /src\/main.ts, Lines 7–8, 1 held, 2 waiting/);
    assert.match(html, /New \/ absent/);
    assert.match(html, /data-map-changeset="c1"/); assert.match(html, /data-map-changeset="c2"/);
    assert.doesNotMatch(html, /data-map-changeset="c3"/);
    assert.match(html, /deduplicated estimates, not a queue position/);
});

test('file inspector names connected journeys and opens the exact repository file', () => {
    const html = render({ selection: { file: 'src/main.ts', start: 7, end: 8 } });
    assert.match(html, /FILE INSPECTOR/); assert.match(html, /Changesets in lines 7–8/);
    assert.match(html, /Add parser/); assert.match(html, /Improve errors/);
    assert.match(html, /href="\/repositories\/repo\?file=src%2Fmain.ts"/);
    assert.match(html, /1 held locks · 2 waiting requests/);
});

test('changeset inspector exposes related paths and a journey deep link', () => {
    const html = render({ selection: { changeset: 'c1' } });
    assert.match(html, /CHANGESET INSPECTOR/);
    assert.match(html, /href="\/repositories\/repo\/journeys\/j1"/);
    assert.match(html, /Connected files/); assert.match(html, /src\/new.ts/);
});

test('rendering is bounded and announces hidden pages instead of discarding files', () => {
    const manyFiles = Array.from({ length: 30 }, (_, index) => ({ path: `file-${index}.ts`, lineCount: 10, exists: true, regions: [] }));
    const html = render({ snapshot: { ...snapshot, files: manyFiles } });
    assert.equal((html.match(/data-map-file=/g) ?? []).length, 6);
    assert.match(html, /1–6 of 30/);
    assert.match(html, /aria-label="Next files"/);
});

test('failed refresh keeps visible data and clearly marks it as stale', () => {
    const html = render({ live: { error: 'Network unavailable' } });
    assert.match(html, /Connection interrupted/);
    assert.match(html, /Showing the last successful snapshot/);
    assert.match(html, /data-map-file="src\/main.ts"/);
});


test('following a completed inspector connection reveals its card and related file', () => {
    let select;
    const updates = [];
    render({
        selection: { file: 'src/main.ts' },
        onState: (index, value) => updates.push([index, value]),
        onButton: props => {
            if (nodeText(props.children).includes('Earlier work')) select = props.onClick;
        },
    });
    assert.equal(typeof select, 'function'); select();
    assert.ok(updates.some(([index, value]) => index === 2 && value === true), 'Include completed is enabled for the connected node');
    assert.ok(updates.some(([index, value]) => index === 4 && value === 0), 'the changeset page is revealed');
    assert.ok(updates.some(([index, value]) => index === 3 && value === 0), 'the file page is revealed');
});

test('following an inspector connection on another changeset page makes the selected card visible', () => {
    const changesets = Array.from({ length: 9 }, (_, index) => ({ ...snapshot.changesets[0], id: `c-${index}`, title: `Journey ${index}`, description: `Change ${index}` }));
    let select;
    const updates = [];
    render({ snapshot: { ...snapshot, changesets }, selection: { file: 'src/main.ts' },
        onState: (index, value) => updates.push([index, value]),
        onButton: props => { if (nodeText(props.children).includes('Change 8')) select = props.onClick; },
    });
    assert.equal(typeof select, 'function'); select();
    assert.ok(updates.some(([index, value]) => index === 4 && value === 1));
});


test('left-column connections remain in row gaps and the outer gutter instead of crossing sibling cards', () => {
    const { mapConnectionPath } = render({ exportsOnly: true });
    const files = [
        { left: 20, right: 220, top: 0, bottom: 180 },
        { left: 230, right: 430, top: 0, bottom: 180 },
        { left: 20, right: 220, top: 190, bottom: 370 },
        { left: 230, right: 430, top: 190, bottom: 370 },
    ];
    const target = { left: 470, right: 720, top: 20, bottom: 120 };
    const route = mapConnectionPath(files[0], target, files);
    const numbers = route.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const [startX, startY, gapX, gapY, gutterX, gutterY, c1x, c1y, c2x, c2y, endX, endY] = numbers;
    assert.equal(startY, files[0].bottom, 'edge visibly originates at the source bottom');
    assert.ok(startX < files[0].right && startX > files[0].left);
    assert.equal(startX, gapX); assert.equal(gapY, gutterY);
    assert.ok(gapY > files[1].bottom && gapY < files[3].top, 'horizontal segment is between rows');
    assert.ok(gapY - files[0].bottom <= 7);
    assert.ok(gutterX > files[1].right && gutterX < target.left);
    assert.ok(c1x >= gutterX && c2x >= gutterX, 'curve stays beyond every file card');
    assert.equal(c1y, gapY); assert.equal(c2y, endY);
    assert.equal(endX, target.left); assert.equal(endY, 70);
    const lastRow = mapConnectionPath(files[2], target, files).match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.equal(lastRow[3], files[2].bottom + 7, 'last-row connection fits within surface bottom padding');
    const unpaired = mapConnectionPath(files[2], target, files.slice(0, 3));
    assert.match(unpaired, / L /, 'an unpaired last left-column file still routes around earlier right-column cards');
});

test('rightmost and single-column connections retain a direct right-edge curve', () => {
    const { mapConnectionPath } = render({ exportsOnly: true });
    const source = { left: 230, right: 430, top: 0, bottom: 180 };
    const target = { left: 470, right: 720, top: 20, bottom: 120 };
    for (const files of [[source], [{ left: 20, right: 220, top: 0, bottom: 180 }, source]]) {
        const route = mapConnectionPath(source, target, files);
        assert.match(route, /^M 430 90 C /);
        assert.doesNotMatch(route, / L /);
        assert.match(route, /470 70$/);
    }
});
