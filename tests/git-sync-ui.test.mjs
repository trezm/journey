import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const journeyHead = '1'.repeat(40), remoteHead = '2'.repeat(40), resolutionHead = 'a'.repeat(40);
const syncState = () => ({
    remote: 'git@example.com:team/repository.git', branch: 'production', enabled: true,
    status: 'conflict', updatedAt: 100,
    run: { id: 'conflict-123', actor: 'runner', journeyHead, remoteHead, phase: 'conflict', conflictBranch: 'journey-conflicts/conflict-123', conflicts: ['src/index.ts'], conflictPublished: true },
});

function warning(initial = {}, response = { ok: true, json: async () => ({ result: {} }) }) {
    const require = createRequire(import.meta.url), state = [], requests = [];
    let cursor = 0, tree, refreshes = 0;
    const source = readFileSync(new URL('../components/git-sync-warning.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const componentModule = { exports: {} };
    runInNewContext(compiled, { module: componentModule, exports: componentModule.exports, fetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return response; }, require: name => {
        if (name === 'react') return { ...React, useState: initialValue => {
            const index = cursor++;
            if (!(index in state)) state[index] = typeof initialValue === 'function' ? initialValue() : initialValue;
            return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
        } };
        if (name === '@/components/ui/button') return { Button: props => React.createElement('button', props) };
        if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        return require(name);
    } });
    const props = { project: 'project/one', sync: syncState(), editable: true, onRefresh: async () => { refreshes++; }, ...initial };
    function render(changed = {}) { Object.assign(props, changed); cursor = 0; tree = componentModule.exports.GitSyncWarning(props); return renderToStaticMarkup(tree); }
    function find(predicate) {
        function walk(node) {
            if (!React.isValidElement(node)) return;
            if (predicate(node)) return node.props;
            for (const child of React.Children.toArray(node.props.children)) { const found = walk(child); if (found) return found; }
        }
        return walk(tree);
    }
    return { render, find, requests, refreshes: () => refreshes };
}

test('conflict warning preserves exact snapshots and separates failed backup publication', () => {
    const sync = syncState();
    sync.status = 'error'; sync.error = 'The repository remains paused.';
    sync.run.conflictPublished = false; sync.run.conflictPublishError = 'Remote rejected the conflict branch.';
    const html = warning({ sync }).render();
    assert.match(html, /Git conflict: repository paused/);
    assert.match(html, new RegExp(`revision=${journeyHead}`));
    assert.match(html, /project=project%2Fone/);
    assert.ok(html.includes(remoteHead));
    assert.match(html, /Remote production at detection/);
    assert.match(html, /journey-conflicts\/conflict-123/);
    assert.match(html, /src\/index.ts/);
    assert.match(html, /publication is not confirmed/);
    assert.match(html, /Remote rejected the conflict branch/);
    assert.doesNotMatch(html, /Conflict branch published\./);
    assert.match(html, /Resume sync/);
});

test('owner resume sends only the explicitly entered full SHA and current run', async () => {
    const view = warning(); view.render();
    const input = () => view.find(node => node.type === 'input');
    const form = () => view.find(node => node.type === 'form');
    input().onChange({ target: { value: 'abc123' } }); view.render();
    await form().onSubmit({ preventDefault() {} });
    assert.equal(view.requests.length, 0);
    input().onChange({ target: { value: resolutionHead.toUpperCase() } }); view.render();
    await form().onSubmit({ preventDefault() {} });
    assert.deepEqual(view.requests, [{ url: '/api/sync', body: { project: 'project/one', action: 'resolve', runId: 'conflict-123', head: resolutionHead } }]);
    assert.equal(view.refreshes(), 1);
    assert.match(view.render(), /Resolution requested/);
    assert.match(view.render(), /repository paused/);
});

test('runner identities cannot authorize a resolution from the warning', () => {
    const view = warning({ editable: false });
    const html = view.render();
    assert.equal(view.find(node => node.type === 'form'), undefined);
    assert.match(html, /repository owner must confirm/);
    assert.match(html, /Conflict branch published/);
});

test('a moved remote during resolution can be corrected with a new exact SHA', async () => {
    const sync = syncState(); sync.status = 'error'; sync.run.phase = 'resolving'; sync.run.resolutionHead = remoteHead;
    const view = warning({ sync });
    assert.match(view.render(), /Applying your Git resolution/);
    assert.match(view.render(), /Update resolution &amp; resume/);
    view.find(node => node.type === 'input').onChange({ target: { value: resolutionHead } }); view.render();
    await view.find(node => node.type === 'form').onSubmit({ preventDefault() {} });
    assert.equal(view.requests[0].body.head, resolutionHead);
});

test('resume rejection retains recovery form and never reports success', async () => {
    const view = warning({}, { ok: false, json: async () => ({ error: 'The sync run changed.' }) }); view.render();
    view.find(node => node.type === 'input').onChange({ target: { value: resolutionHead } }); view.render();
    await view.find(node => node.type === 'form').onSubmit({ preventDefault() {} });
    const html = view.render();
    assert.match(html, /The sync run changed/);
    assert.doesNotMatch(html, /Resolution requested/);
    assert.equal(view.refreshes(), 0);
    assert.ok(view.find(node => node.type === 'form'));
});

test('normal active sync explains the pause without offering conflict resolution', () => {
    const sync = syncState(); sync.status = 'running'; sync.run.phase = 'publishing'; delete sync.run.conflicts;
    const view = warning({ sync });
    const html = view.render();
    assert.match(html, /Repository paused for Git sync/);
    assert.match(html, /original connection file/);
    assert.equal(view.find(node => node.type === 'form'), undefined);
    assert.equal(view.render({ sync: { ...sync, status: 'idle', run: undefined } }), '');
});
