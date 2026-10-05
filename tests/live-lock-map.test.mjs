import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as routes from '../lib/workspace-route.ts';
import * as model from '../lib/live-map.ts';

const nodeText = node => Array.isArray(node) ? node.map(nodeText).join(' ') : React.isValidElement(node) ? nodeText(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const file = (path, overrides = {}) => ({ path, lineCount: 100, exists: true, regions: [], heldLocks: [], lockCount: 0, conflictCount: 0, waitingCount: 0, updatedAt: 0, ...overrides });
const snapshot = {
    head: 'abcdef012345', sequence: 14, updatedAt: 100,
    files: [file('src/main.ts', { heldLocks: [{ id: 'l1', journey: 'j1', changeset: 'c1', conflictingRequestIds: ['w1'] }], lockCount: 1, conflictCount: 1, waitingCount: 1, updatedAt: 50, regions: [{ start: 7, end: 8, status: 'waiting', waitingIds: ['w1'], lockIds: ['l1'], changesetIds: ['c1', 'c2'], approximate: false }] }), file('src/new.ts', { exists: false, heldLocks: [{ id: 'l2', journey: 'j1', changeset: 'c1', conflictingRequestIds: [] }], lockCount: 1 }), file('src/idle.ts')],
    changesets: [
        { id: 'c1', journey: 'j1', title: 'Add parser', description: 'Share the parsing helpers', paths: ['src/main.ts', 'src/new.ts', 'src/idle.ts'], status: 'working', lockCount: 2, waitingCount: 0, patchCount: 1 },
        { id: 'c2', journey: 'j2', title: 'Improve errors', description: 'Handle invalid input', paths: ['src/main.ts'], status: 'review', lockCount: 0, waitingCount: 1, patchCount: 0 },
        { id: 'c3', journey: 'j3', title: 'Earlier work', description: 'Completed parsing work', paths: ['src/main.ts'], status: 'integrated', lockCount: 0, waitingCount: 0, patchCount: 4 },
    ], summary: { fileCount: 3, lockedRegions: 2, waitingCount: 1, contendedRegions: 0 },
};
function render(options = {}) {
    const require = createRequire(import.meta.url);
    const code = ts.transpileModule(readFileSync(new URL('../components/live-lock-map.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const compiled = { exports: {} };
    let stateIndex = 0;
    const initial = [options.view ?? 'list', options.query ?? '', options.activityOnly ?? true, options.page ?? 0, options.selection ?? {}];
    const mockRequire = name => {
        if (name === 'react') return { ...React, useRef: () => ({ current: options.inspector ?? null }), useState: value => { const index = stateIndex++; return [index < initial.length ? initial[index] : value, next => options.onState?.(index, next)]; } };
        if (name === 'react/jsx-runtime') {
            const runtime = require(name);
            const wrap = fn => (type, props, ...rest) => { if (type === 'button' || type === 'g') options.onButton?.(props); return fn(type, props, ...rest); };
            return { ...runtime, jsx: wrap(runtime.jsx), jsxs: wrap(runtime.jsxs) };
        }
        if (name === '@/hooks/use-live-lock-map') return { useLiveLockMap: () => ({ key: 'repo', data: options.snapshot ?? snapshot, running: true, loading: false, paused: false, receivedAt: 100, error: '', refresh: async () => {}, setPaused: () => {}, ...options.live }) };
        if (name === '@/lib/workspace-route') return routes;
        if (name === '@/lib/live-map') return model;
        if (name === './live-lock-map.module.css') return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        return require(name);
    };
    runInNewContext(code, { module: compiled, exports: compiled.exports, require: mockRequire, Date, requestAnimationFrame: callback => callback() });
    return renderToStaticMarkup(React.createElement(compiled.exports.LiveLockMap, { project: 'repo' }));
}

test('default ranked list prioritizes active files and exposes ordered metrics and timestamps', () => {
    const html = render();
    assert.match(html, /Sorted by conflicting locks, held locks, then latest activity/);
    assert.match(html, /data-map-file="src\/main.ts"/); assert.match(html, /data-map-file="src\/new.ts"/);
    assert.doesNotMatch(html, /data-map-file="src\/idle.ts"/);
    assert.match(html, /<time dateTime="1970-01-01T00:00:00.050Z"/);
    assert.match(html, /aria-pressed="true"[^>]*>Ranked files/);
    assert.match(html, /New \/ absent/);
});

test('view toggle changes mode and resets paging while retaining selection', () => {
    let toggle; const updates = [];
    render({ page: 2, selection: { file: 'src/main.ts' }, onState: (index, value) => updates.push([index, value]), onButton: props => { if (nodeText(props.children).trim() === 'Lock graph') toggle = props.onClick; } });
    toggle(); assert.deepEqual(updates, [[0, 'graph'], [3, 0]]);
});

test('graph uses held edges only, omits idle files and waiters, and exposes keyboard nodes', () => {
    const html = render({ view: 'graph' });
    assert.match(html, /data-map-changeset="c1"/); assert.doesNotMatch(html, /data-map-changeset="c[23]"/);
    assert.match(html, /data-map-edge="c1:src\/main.ts"/); assert.doesNotMatch(html, /data-map-file="src\/idle.ts"/);
    assert.match(html, /role="button" tabindex="0"/); assert.match(html, /aria-label="Zoom in"/);
    assert.match(html, /aria-hidden="true" class="edgePulse"/);
    assert.match(html, /Connections show held locks only/);
});

test('Inspect scrolls and focuses details only after explicit selection, including keyboard graph activation', () => {
    for (const view of ['list', 'graph']) {
        const calls = []; let control;
        const inspector = { focus: options => calls.push(['focus', options.preventScroll]), scrollIntoView: options => calls.push(['scroll', options.block]) };
        render({ view, inspector, onState: (index, value) => calls.push(['state', index, value.file]), onButton: props => { if (view === 'list' ? props['aria-label'] === 'Inspect src/main.ts' : props['data-map-file'] === 'src/main.ts') control = props; } });
        assert.deepEqual(calls, [], 'Rendering/polling never shifts focus');
        if (view === 'list') control.onClick(); else control.onKeyDown({ key: 'Enter', preventDefault: () => calls.push(['prevent']) });
        assert.ok(calls.some(call => call[0] === 'state' && call[2] === 'src/main.ts'));
        assert.ok(calls.some(call => call[0] === 'focus')); assert.ok(calls.some(call => call[0] === 'scroll'));
    }
});

test('file inspector displays exact source link, scopes, and connected journeys', () => {
    const html = render({ selection: { file: 'src/main.ts', start: 7, end: 8 } });
    assert.match(html, /FILE INSPECTOR/); assert.match(html, /Changesets in lines 7–8/);
    assert.match(html, /Add parser/); assert.match(html, /Improve errors/);
    assert.match(html, /href="\/repositories\/repo\?file=src%2Fmain.ts"/);
    assert.match(html, /1 held locks · 1 conflicting · 1 waiting requests/);
    assert.match(html, /tabindex="-1" aria-label="Map inspector"/);
});

test('changeset inspector distinguishes locked from all related files and opens its journey', () => {
    const html = render({ selection: { changeset: 'c1' } });
    assert.match(html, /CHANGESET INSPECTOR/); assert.match(html, /href="\/repositories\/repo\/journeys\/j1"/);
    assert.match(html, /Locked files/); assert.match(html, /All related files/);
});

test('bounded list and graph pages retain counts, clamp shrinking live results and apply search', () => {
    const files = Array.from({ length: 55 }, (_, index) => file(`file-${String(index).padStart(2, '0')}.ts`, { lockCount: 1, heldLocks: [{ id: `l${index}`, journey: 'j1', changeset: 'c1', conflictingRequestIds: [] }] }));
    for (const view of ['list', 'graph']) {
        const html = render({ view, snapshot: { ...snapshot, files }, page: 20 });
        assert.equal((html.match(/data-map-file=/g) ?? []).length, 15);
        assert.match(html, /41–55 of 55 files/); assert.match(html, /aria-label="Previous files"/);
        const searched = render({ view, snapshot: { ...snapshot, files }, query: 'file-03' });
        assert.equal((searched.match(/data-map-file=/g) ?? []).length, 1);
    }
});

test('failed refresh preserves data and empty graph explains why no nodes appear', () => {
    const html = render({ live: { error: 'Network unavailable' } });
    assert.match(html, /Connection interrupted/); assert.match(html, /Showing the last successful snapshot/);
    assert.match(html, /data-map-file="src\/main.ts"/);
    assert.match(render({ view: 'graph', snapshot: { ...snapshot, files: [file('idle')] } }), /No held locks to connect/);
});

test('decorative pulse is bounded and reduced motion disables it', () => {
    const css = readFileSync(new URL('../components/live-lock-map.module.css', import.meta.url), 'utf8');
    assert.match(css, /prefers-reduced-motion: reduce[^}]*\{[^}]*\} \.edgePulse \{ display: none; animation: none;/);
    const many = Array.from({ length: 70 }, (_, index) => ({ ...snapshot.changesets[0], id: `c${index}` }));
    const files = [file('shared', { lockCount: 70, heldLocks: many.map((change, index) => ({ id: `l${index}`, changeset: change.id, journey: change.journey, conflictingRequestIds: [] })) })];
    const html = render({ view: 'graph', snapshot: { ...snapshot, files, changesets: many } });
    assert.equal((html.match(/data-map-edge=/g) ?? []).length, 70);
    assert.equal((html.match(/class="edgePulse"/g) ?? []).length, 60);
});
