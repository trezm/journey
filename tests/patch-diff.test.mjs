import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { diff } from '../lib/avc/core.ts';
import * as helpers from '../lib/patch-diff.ts';
import * as reviewHelpers from '../lib/patch-review.ts';

const sections = (before, after, context) => helpers.patchSections(before, after, diff(before, after), context);

test('side by side aligns replacements and keeps separate immutable old/new line numbers', () => {
    const [section] = sections('head\nold\ntail\n', 'head\nnew\nextra\ntail\n');
    assert.deepEqual(section.lines, [
        { kind: 'context', text: 'head', before: 1, after: 1 },
        { kind: 'removed', text: 'old', before: 2 },
        { kind: 'added', text: 'new', after: 2 },
        { kind: 'added', text: 'extra', after: 3 },
        { kind: 'context', text: 'tail', before: 3, after: 4 },
    ]);
    assert.equal(section.rows[1].before.text, 'old');
    assert.equal(section.rows[1].after.text, 'new');
    assert.equal(section.rows[2].before, undefined);
    assert.equal(section.rows[2].after.text, 'extra');
    assert.deepEqual([section.beforeStart, section.beforeCount, section.afterStart, section.afterCount], [1, 3, 1, 4]);
});

test('distant hunks have bounded context and correct offsets after earlier insertions', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 2\n', 'line 2\ninserted\n').replace('line 24', 'replacement');
    const result = sections(before, after);
    assert.equal(result.length, 2);
    assert.equal(result[1].beforeStart, 21);
    assert.equal(result[1].afterStart, 22);
    assert.equal(result[1].lines.find(line => line.kind === 'removed').before, 24);
    assert.equal(result[1].lines.find(line => line.kind === 'added').after, 25);
    assert.ok(result.flatMap(section => section.lines).length < 20);
});

test('nearby hunks merge without duplicate context', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const [section] = sections(before, 'a\nB\nc\nd\nE\nf\ng\nh\n');
    assert.equal(section.lines.filter(line => line.text === 'c').length, 1);
    assert.equal(section.lines.filter(line => line.text === 'd').length, 1);
    assert.equal(section.rows.length, 8);
});

test('new, deleted, and empty files preserve presence and omit phantom final lines', () => {
    assert.equal(helpers.patchFileStatus(undefined, ''), 'Added file');
    assert.equal(helpers.patchFileStatus('', undefined), 'Deleted file');
    assert.equal(helpers.patchFileStatus('', ''), 'Modified file');
    assert.deepEqual(sections('', '', 3), []);
    const [created] = sections('', 'one\ntwo\n');
    assert.equal(created.beforeCount, 0);
    assert.equal(created.beforeStart, 0);
    assert.equal(created.afterCount, 2);
    assert.ok(created.rows.every(row => row.before === undefined));
    const [deleted] = sections('one\ntwo\n', '');
    assert.equal(deleted.beforeCount, 2);
    assert.equal(deleted.afterCount, 0);
    assert.ok(deleted.rows.every(row => row.after === undefined));
    const [blank] = sections('', '\n');
    assert.equal(blank.lines.length, 1);
    assert.equal(blank.lines[0].text, '');
});

test('final newline changes keep real line numbers without inventing a blank line', () => {
    const [added] = sections('one', 'one\n');
    assert.deepEqual(added.lines, [{ kind: 'context', text: 'one', before: 1, after: 1 }]);
    const [removed] = sections('one\n', 'one');
    assert.deepEqual(removed.lines, added.lines);
});

test('different insertion/deletion combinations reconstruct both visible sources', () => {
    const texts = ['', '\n', 'a', 'a\n', 'a\nb', 'a\na\nb\n', 'b\nc\na', 'a\nb\nc\nd\n'];
    const realLines = text => text ? text.replace(/\n$/, '').split('\n') : [];
    for (const before of texts) for (const after of texts) {
        if (before === after) continue;
        const lines = sections(before, after, 100).flatMap(section => section.lines);
        assert.deepEqual(lines.filter(line => line.before !== undefined).map(line => line.text), realLines(before), `before ${JSON.stringify({ before, after })}`);
        assert.deepEqual(lines.filter(line => line.after !== undefined).map(line => line.text), realLines(after), `after ${JSON.stringify({ before, after })}`);
    }
});

const beforeText = 'const oldValue = 1;\nreturn oldValue;\n';
const afterText = 'const newValue = 2;\nreturn newValue;\n';
const patch = { id: 'p1', before: 'before-immutable', after: 'after-immutable', at: 0, description: 'Rename value', changes: [{ path: 'app.ts', hunks: diff(beforeText, afterText) }] };
function renderViewer(options = {}) {
    const calls = [], controls = [], updates = [], highlightCalls = [], state = [];
    const storage = options.storage ?? new Map();
    let cursor = 0;
    const source = readFileSync(new URL('../components/patch-viewer.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const require = createRequire(import.meta.url), testModule = { exports: {} };
    const jsx = require('react/jsx-runtime');
    const mockRequire = name => {
        if (name === 'react') return { ...React, useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useState: initial => {
            const index = cursor++;
            if (!(index in state)) state[index] = index === 0 ? options.requested ?? false : initial === 'split' ? options.view ?? 'split' : typeof initial === 'function' ? initial() : initial;
            return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; updates.push(value); }];
        } };
        if (name === 'react/jsx-runtime') return { ...jsx, ...Object.fromEntries(['jsx', 'jsxs'].map(method => [method, (type, props, key) => { if (type === 'details' || type === 'button' || type === 'input' || type === 'form' || type === 'textarea') controls.push({ type, ...props }); return jsx[method](type, props, key); }])) };
        if (name === '@/hooks/use-repository') return { useRepositoryFiles: (project, revision) => {
            calls.push({ project, revision });
            return { status: options.status ?? 'ready', error: options.error ?? '', files: revision === patch.before ? options.before ?? { 'app.ts': beforeText } : options.after ?? { 'app.ts': afterText }, reload: () => {} };
        } };
        if (name === './review-threads') return { ReviewThreads: ({ reviews }) => React.createElement('div', {}, reviews.map(review => React.createElement('p', { key: review.id }, review.body))) };
        if (name === '@/lib/patch-diff') return helpers;
        if (name === '@/lib/patch-review') return reviewHelpers;
        if (name === '@/lib/comment-shortcut') return require('../lib/comment-shortcut.ts');
        if (name === '@/lib/changeset-detail') return { patchLineCommentTarget: (journey, changeset, patch, anchor, body) => ({ journey: journey.id, changeset: changeset.id, revision: journey.head, patch: patch.id, anchor, body }) };
        if (name === '@/lib/syntax-highlight') return { highlightCode: (path, source) => { highlightCalls.push({ path, source }); return { language: 'typescript', lines: source.split('\n').map(value => [{ value, classes: [] }]) }; } };
        if (name === '@/components/syntax-code') return { SyntaxLine: ({ tokens }) => React.createElement('span', {}, tokens.map(token => token.value).join('')) };
        if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => key }) };
        if (name === 'lucide-react') return { GitCommitHorizontal: () => null, ChevronDown: () => null };
        return require(name);
    };
    runInNewContext(compiled, { module: testModule, exports: testModule.exports, require: mockRequire, window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } } });
    function render() {
        cursor = 0; controls.length = 0;
        return renderToStaticMarkup(React.createElement(testModule.exports.PatchViewer, { project: options.project ?? 'project-a', patch: options.patch ?? patch, number: '1.1', reviews: options.reviews ?? [], canComment: options.canComment ?? false, onComment: options.onComment ?? (async () => true), journey: { id: 'journey', head: 'head' }, changeset: { id: 'changeset' } }));
    }
    return { html: render(), render, calls, controls, updates, highlightCalls, storage };
}

test('collapsed patch summaries do not request snapshots; expanding starts lazy loading', () => {
    const rendered = renderViewer();
    assert.deepEqual(rendered.calls, []);
    assert.doesNotMatch(rendered.html, /const oldValue/);
    const details = rendered.controls.find(control => control.type === 'details');
    details.onToggle({ currentTarget: { open: false } });
    assert.deepEqual(rendered.updates, []);
    details.onToggle({ currentTarget: { open: true } });
    assert.deepEqual(rendered.updates, [true]);
});

test('expanded viewer uses exact patch revisions and offers accessible view toggles', () => {
    const rendered = renderViewer({ requested: true });
    assert.deepEqual(rendered.calls, [{ project: 'project-a', revision: patch.before }, { project: 'project-a', revision: patch.after }]);
    assert.match(rendered.html, /Side by side/);
    assert.match(rendered.html, /aria-pressed="true"[^>]*>Side by side/);
    assert.match(rendered.html, /const oldValue = 1;/);
    assert.match(rendered.html, /const newValue = 2;/);
    assert.match(rendered.html, /Before<\/th>/);
    assert.match(rendered.html, /After<\/th>/);
    assert.deepEqual(rendered.highlightCalls, [{ path: 'app.ts', source: beforeText }, { path: 'app.ts', source: afterText }]);
    rendered.controls.find(control => control.children === 'Unified').onClick();
    assert.deepEqual(rendered.updates, ['unified']);
    const unified = renderViewer({ requested: true, view: 'unified' });
    assert.match(unified.html, /scope="col">Old/);
    assert.match(unified.html, /scope="col">New/);
    assert.match(unified.html, /aria-pressed="true"[^>]*>Unified/);
});

test('snapshot loading and errors never present unavailable content as an empty diff', () => {
    assert.match(renderViewer({ requested: true, status: 'loading' }).html, /Loading patch revisions/);
    const errored = renderViewer({ requested: true, status: 'error', error: 'Unavailable' }).html;
    assert.match(errored, /Unable to load this patch: Unavailable/);
    assert.match(errored, /Retry/);
    assert.doesNotMatch(errored, /Empty file|const oldValue/);
});

test('viewer identifies empty creations/deletions, newline changes and safely renders source', () => {
    const emptyPatch = { ...patch, changes: [{ path: 'app.ts', hunks: [] }] };
    assert.match(renderViewer({ requested: true, patch: emptyPatch, before: {}, after: { 'app.ts': '' } }).html, /Empty file added/);
    assert.match(renderViewer({ requested: true, patch: emptyPatch, before: { 'app.ts': '' }, after: {} }).html, /Empty file deleted/);
    const newlinePatch = { ...patch, changes: [{ path: 'app.ts', hunks: diff('one', 'one\n') }] };
    assert.match(renderViewer({ requested: true, patch: newlinePatch, before: { 'app.ts': 'one' }, after: { 'app.ts': 'one\n' } }).html, /Final newline added/);
    const htmlPatch = { ...patch, changes: [{ path: 'app.ts', hunks: diff('', '<script>attack()</script>') }] };
    const html = renderViewer({ requested: true, patch: htmlPatch, before: {}, after: { 'app.ts': '<script>attack()</script>' } }).html;
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

test('file disclosure controls have accessible state and operate independently', () => {
    const secondPath = 'src/other.ts';
    const view = renderViewer({ requested: true, patch: { ...patch, changes: [...patch.changes, { path: secondPath, hunks: diff('', 'second file') }] }, after: { 'app.ts': afterText, [secondPath]: 'second file' } });
    const collapse = view.controls.find(control => control['aria-label'] === 'Collapse app.ts');
    assert.equal(collapse.type, 'button');
    assert.equal(collapse['aria-expanded'], true);
    assert.ok(collapse['aria-controls']);
    collapse.onClick();
    let html = view.render();
    assert.doesNotMatch(html, /const oldValue/);
    assert.match(html, /second file/);
    assert.equal(view.controls.find(control => control['aria-label'] === `Collapse ${secondPath}`)['aria-expanded'], true);
    view.controls.find(control => control['aria-label'] === 'Expand app.ts').onClick();
    html = view.render();
    assert.match(html, /const oldValue/);
    assert.match(html, /0 of 2 files viewed/);
});

test('marking a file viewed collapses it, updates progress, and persists only for the immutable patch and repository', () => {
    const view = renderViewer({ requested: true });
    const checkbox = () => view.controls.find(control => control['aria-label'] === 'Mark app.ts as viewed');
    assert.equal(checkbox().checked, false);
    checkbox().onChange({ target: { checked: true } });
    let html = view.render();
    assert.match(html, /1 of 1 files viewed/);
    assert.doesNotMatch(html, /const oldValue/);
    assert.equal(checkbox().checked, true);
    view.controls.find(control => control['aria-label'] === 'Expand app.ts').onClick();
    html = view.render();
    assert.match(html, /const oldValue/);
    assert.equal(checkbox().checked, true);
    const revisited = renderViewer({ requested: true, storage: view.storage });
    assert.match(revisited.html, /1 of 1 files viewed/);
    assert.doesNotMatch(revisited.html, /const oldValue/);
    assert.match(renderViewer({ requested: true, storage: view.storage, patch: { ...patch, id: 'p2', after: 'new-immutable' } }).html, /0 of 1 files viewed/);
    assert.match(renderViewer({ requested: true, storage: view.storage, project: 'project-b' }).html, /0 of 1 files viewed/);
    checkbox().onChange({ target: { checked: false } });
    assert.match(view.render(), /0 of 1 files viewed/);
    assert.match(view.render(), /const oldValue/);
    assert.match(renderViewer({ requested: true, storage: view.storage }).html, /0 of 1 files viewed/);
});

test('line discussions stay on their immutable patch path, side, and line and remain visible read-only', () => {
    const reviews = [
        { id: 'old-comment', actor: 'reviewer', body: 'This deleted line is intentional?', kind: 'comment', revision: 'head', patch: 'p1', anchor: { path: 'app.ts', side: 'before', line: 1, context: 'const oldValue = 1;' }, at: 1 },
        { id: 'new-comment', actor: 'author', body: 'Updated implementation detail', kind: 'comment', revision: 'head', patch: 'p1', anchor: { path: 'app.ts', side: 'after', line: 1, context: 'const newValue = 2;' }, at: 2 },
        { id: 'sibling', actor: 'other', body: 'must stay elsewhere', kind: 'comment', revision: 'head', patch: 'elsewhere', anchor: { path: 'app.ts', side: 'after', line: 1, context: 'const newValue = 2;' }, at: 3 },
    ];
    const html = renderViewer({ requested: true, reviews, canComment: false }).html;
    assert.match(html, /This deleted line is intentional\?/);
    assert.match(html, /Updated implementation detail/);
    assert.doesNotMatch(html, /must stay elsewhere/);
    assert.match(html, /before line 1/);
    assert.match(html, /after line 1/);
    assert.doesNotMatch(html, /aria-label="Add comments on app\.ts/);
});

test('unified diffs keep before and after discussions on unchanged context lines', () => {
    const contextPatch = { ...patch, changes: [{ path: 'app.ts', hunks: diff('old\nshared\n', 'new\nshared\n') }] };
    const reviews = [
        { id: 'before', actor: 'reviewer', body: 'old-side note', kind: 'comment', revision: 'head', patch: 'p1', anchor: { path: 'app.ts', side: 'before', line: 2, context: 'shared' }, at: 1 },
        { id: 'after', actor: 'reviewer', body: 'new-side note', kind: 'comment', revision: 'head', patch: 'p1', anchor: { path: 'app.ts', side: 'after', line: 2, context: 'shared' }, at: 2 },
    ];
    const rendered = renderViewer({ requested: true, view: 'unified', patch: contextPatch, before: { 'app.ts': 'old\nshared\n' }, after: { 'app.ts': 'new\nshared\n' }, reviews });
    assert.match(rendered.html, /old-side note/);
    assert.match(rendered.html, /new-side note/);
});

test('line composer submits a stable anchor and preserves drafts after false saves or stale errors', async () => {
    for (const shouldThrow of [false, true]) {
        const calls = [];
        const onComment = async target => { calls.push(target); if (shouldThrow) throw new Error('Comment targets an old revision.'); return false; };
        const view = renderViewer({ requested: true, canComment: true, onComment });
        view.controls.find(control => control['aria-label'] === 'Add comments on app.ts, after line 1').onClick();
        view.render();
        view.controls.find(control => control.type === 'textarea').onChange({ target: { value: 'Keep this note' } });
        view.render();
        await view.controls.find(control => control.type === 'form').onSubmit({ preventDefault() {} });
        const html = view.render();
        assert.equal(calls[0].patch, 'p1');
        assert.equal(calls[0].anchor.path, 'app.ts');
        assert.equal(calls[0].anchor.side, 'after');
        assert.equal(calls[0].anchor.line, 1);
        assert.equal(calls[0].anchor.context, 'const newValue = 2;');
        assert.match(html, /Keep this note/);
        assert.match(html, /Comment was not saved|Comment targets an old revision/);
    }
});


test('context expansion reveals ten lines independently above and below and joins adjacent sections', () => {
    const before = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const after = before.replace('line 25\n', 'changed 25\ninserted\n').replace('line 55\n', 'changed 55\n');
    const hunks = diff(before, after);
    const original = helpers.patchSections(before, after, hunks);
    const up = helpers.patchSections(before, after, hunks, [{ before: 13, after: 3 }]);
    assert.equal(original[0].beforeStart - up[0].beforeStart, 10);
    assert.equal(up[0].beforeCount - original[0].beforeCount, 10);
    assert.equal(up[1].beforeStart, original[1].beforeStart);
    const down = helpers.patchSections(before, after, hunks, [{ before: 3, after: 13 }]);
    assert.equal(down[0].beforeStart, original[0].beforeStart);
    assert.equal(down[0].beforeCount - original[0].beforeCount, 10);
    const joined = helpers.patchSections(before, after, hunks, [{ before: 103, after: 33 }, { before: 33, after: 103 }]);
    assert.equal(joined.length, 1);
    assert.equal(joined[0].hiddenBefore, 0);
    assert.equal(joined[0].hiddenAfter, 0);
    assert.equal(joined[0].firstHunk, 0);
    assert.equal(joined[0].lastHunk, 1);
    const oldNumbers = joined[0].lines.flatMap(line => line.before === undefined ? [] : [line.before]);
    assert.deepEqual(oldNumbers, Array.from({ length: 100 }, (_, i) => i + 1));
    assert.equal(joined[0].lines.find(line => line.text === 'line 56').after, 57);
});

test('context buttons persist expansion across diff views and file collapse; lines comment without plus controls', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 20\n', 'changed\n');
    const contextPatch = { ...patch, changes: [{ path: 'app.ts', hunks: diff(before, after) }] };
    const viewer = renderViewer({ requested: true, canComment: true, patch: contextPatch, before: { 'app.ts': before }, after: { 'app.ts': after } });
    const expansion = direction => viewer.controls.find(control => control.children?.[0] === `${direction === 'up' ? '↑' : '↓'} Expand ${direction} `);
    assert.doesNotMatch(viewer.html, /lineCommentToggle/);
    expansion('up').onClick();
    let html = viewer.render();
    assert.match(html, />line 7</);
    assert.doesNotMatch(html, />line 6</);
    expansion('down').onClick();
    html = viewer.render();
    assert.match(html, />line 33</);
    assert.doesNotMatch(html, />line 34</);
    viewer.controls.find(control => control.children === 'Unified').onClick();
    html = viewer.render();
    assert.match(html, />line 7</);
    assert.match(html, />line 33</);
    viewer.controls.find(control => control['aria-label'] === 'Collapse app.ts').onClick();
    viewer.render();
    viewer.controls.find(control => control['aria-label'] === 'Expand app.ts').onClick();
    viewer.render();
    viewer.controls.find(control => control['aria-label'] === 'Add comments on app.ts, after line 7').onClick();
    assert.match(viewer.render(), /Comment on after line 7/);
    expansion('up').onClick();
    viewer.render();
    assert.equal(expansion('up'), undefined);
});
