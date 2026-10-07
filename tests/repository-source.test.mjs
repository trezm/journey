import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { LatestResource } from '../lib/repository-code.ts';

const compiled = ts.transpileModule(readFileSync(new URL('../components/repository-source.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function render({ chosenPath = '', entries = [{ name: 'README.md', mode: '100644' }, { name: 'src', mode: '40000' }], treeStatus = 'ready', sourceStatus = 'ready', file = { kind: 'text', content: 'Preview content' }, error = '' } = {}) {
    const calls = [], buttons = [], selections = [], testModule = { exports: {} }, require = createRequire(import.meta.url);
    runInNewContext(compiled, { module: testModule, exports: testModule.exports, require: name => {
        if (name === '@/hooks/use-repository') return {
            useSourceTree: (...args) => { calls.push(['tree', ...args]); return { status: treeStatus, data: treeStatus === 'ready' ? { entries } : undefined, error: '', reload() {} }; },
            useSourceFile: (...args) => { calls.push(['file', ...args]); return { status: sourceStatus, data: sourceStatus === 'ready' ? { file } : undefined, error, reload() {} }; },
        };
        if (name === './syntax-code') return { SyntaxSource: props => React.createElement('pre', { 'data-path': props.path }, props.source) };
        if (name === './ui/button') return { Button: props => { buttons.push(props); return React.createElement('button', props); } };
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        return require(name);
    } });
    const html = renderToStaticMarkup(React.createElement(testModule.exports.RepositorySource, { project: 'repo', revision: 'head', chosenPath, onPathChange: path => selections.push(path) }));
    return { html, calls, buttons, selections };
}
test('source component requests only directory and selected file, preserving file deep links and breadcrumbs', () => {
    const view = render({ chosenPath: 'src/nested/index.ts', entries: [{ name: 'index.ts', mode: '100644' }] });
    assert.deepEqual(view.calls, [['tree', 'repo', 'head', 'src/nested'], ['file', 'repo', 'head', 'src/nested/index.ts']]);
    assert.match(view.html, /aria-label="Source tree"/);
    assert.match(view.html, /Preview content/);
    view.buttons[0].onClick(); assert.equal(view.selections.at(-1), '');
    view.buttons[1].onClick(); assert.equal(view.selections.at(-1), 'src/');
});
test('directory loading, no selection, removed file and directories never fetch blobs', () => {
    for (const options of [
        { treeStatus: 'loading' },
        { chosenPath: 'src/', entries: [{ name: 'index.ts', mode: '100644' }] },
        { chosenPath: 'removed.txt' },
        { chosenPath: 'src' },
    ]) {
        const view = render(options);
        assert.equal(view.calls[1][3], '');
        assert.doesNotMatch(view.html, /Preview content/);
    }
});
test('empty text renders as source; unavailable files and errors are explicit without hiding navigation', () => {
    assert.match(render({ file: { kind: 'text', content: '' } }).html, /<pre data-path="README.md"><\/pre>/);
    for (const kind of ['binary', 'large', 'symlink', 'submodule']) {
        const { html } = render({ file: { kind } });
        assert.match(html, /remains available in the Git repository/);
        assert.match(html, /aria-label="Source tree"/);
    }
    const failed = render({ sourceStatus: 'error', error: 'Storage unavailable' }).html;
    assert.match(failed, /Storage unavailable/); assert.match(failed, /Try again/);
    assert.match(render({ sourceStatus: 'loading' }).html, /Loading README.md/);
});
test('file and revision switching ignores late responses even when fetch ignores abort', async () => {
    const pending = [], states = [];
    const resource = new LatestResource((key, signal) => new Promise(resolve => pending.push({ key, signal, resolve })), value => states.push(value));
    resource.select(JSON.stringify(['repo', 'old', 'src/file.ts'])); const old = resource.load();
    resource.select(JSON.stringify(['repo', 'new', 'src/other.ts'])); const next = resource.load();
    assert.equal(states.at(-1).data, undefined); assert(pending[0].signal.aborted);
    pending[1].resolve({ file: { kind: 'text', content: 'new source' } }); await next;
    pending[0].resolve({ file: { kind: 'text', content: 'stale source' } }); await old;
    assert.equal(states.at(-1).data.file.content, 'new source');
});
