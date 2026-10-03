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
    const calls = [], controls = [], updates = [], highlightCalls = [];
    const source = readFileSync(new URL('../components/patch-viewer.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const require = createRequire(import.meta.url), testModule = { exports: {} };
    const jsx = require('react/jsx-runtime');
    const mockRequire = name => {
        if (name === 'react') return { ...React, useState: initial => [typeof initial === 'boolean' ? options.requested ?? false : options.view ?? 'split', value => updates.push(value)] };
        if (name === 'react/jsx-runtime') return { ...jsx, ...Object.fromEntries(['jsx', 'jsxs'].map(method => [method, (type, props, key) => { if (type === 'details' || type === 'button') controls.push({ type, ...props }); return jsx[method](type, props, key); }])) };
        if (name === '@/hooks/use-repository') return { useRepositoryFiles: (project, revision) => {
            calls.push({ project, revision });
            return { status: options.status ?? 'ready', error: options.error ?? '', files: revision === patch.before ? options.before ?? { 'app.ts': beforeText } : options.after ?? { 'app.ts': afterText }, reload: () => {} };
        } };
        if (name === '@/lib/patch-diff') return helpers;
        if (name === '@/lib/syntax-highlight') return { highlightCode: (path, source) => { highlightCalls.push({ path, source }); return { language: 'typescript', lines: source.split('\n').map(value => [{ value, classes: [] }]) }; } };
        if (name === '@/components/syntax-code') return { SyntaxLine: ({ tokens }) => React.createElement('span', {}, tokens.map(token => token.value).join('')) };
        if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => key }) };
        if (name === 'lucide-react') return { GitCommitHorizontal: () => null, ChevronDown: () => null };
        return require(name);
    };
    runInNewContext(compiled, { module: testModule, exports: testModule.exports, require: mockRequire });
    const html = renderToStaticMarkup(React.createElement(testModule.exports.PatchViewer, { project: 'project-a', patch: options.patch ?? patch, number: '1.1' }));
    return { html, calls, controls, updates, highlightCalls };
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
