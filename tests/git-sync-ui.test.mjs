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
        if (name === 'lucide-react') return new Proxy({}, { get: () => props => React.createElement('svg', props) });
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
    const sync = syncState(); sync.status = 'error'; sync.run.phase = 'resolving'; sync.run.resolutionHead = remoteHead; delete sync.run.conflicts;
    const view = warning({ sync });
    assert.match(view.render(), /Git sync needs attention/);
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

const hosted = (phase = 'import') => {
    const sync = syncState();
    sync.hosted = true; sync.status = 'running'; sync.run.phase = 'preparing'; delete sync.run.conflicts;
    sync.progress = { phase, objects: 1317, pending: 172 };
    return sync;
};

test('hosted import shows live phase-local counters without implying a known total', () => {
    const view = warning({ sync: hosted() });
    const html = view.render();
    assert.match(html, /Importing Git history/);
    assert.match(html, /1,317/); assert.match(html, /172/);
    assert.match(html, /Processed in this phase/); assert.match(html, /Currently queued/);
    assert.match(html, /queue can grow/); assert.match(html, /reset when the phase changes/);
    assert.match(html, /visible revision updates when synchronization finishes/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /spinning/);
    assert.doesNotMatch(html, /aria-valuenow|\d+%|Resume sync/);
    const next = hosted(); next.progress.objects = 1340; next.progress.pending = 190;
    const updated = view.render({ sync: next });
    assert.match(updated, /1,340/); assert.match(updated, /190/);
    assert.doesNotMatch(updated, /1,317/);
});

test('every hosted phase is readable including an empty queue before finalization', () => {
    for (const [phase, title] of Object.entries({ 'remote-ancestry': 'Checking remote history', 'journey-ancestry': 'Checking Journey history', export: 'Uploading Git history', publish: 'Publishing synchronized revision' })) {
        const sync = hosted(phase); sync.progress.objects = 0; sync.progress.pending = 0;
        const html = warning({ sync }).render();
        assert.match(html, new RegExp(title));
        assert.match(html, /Currently queued/);
        assert.doesNotMatch(html, /Up to date|100%/);
    }
});

test('failed or conflicted hosted sync retains saved counts without claiming activity', () => {
    for (const status of ['error', 'conflict']) {
        const sync = hosted(); sync.status = status;
        if (status === 'conflict') sync.run.phase = 'conflict';
        else sync.error = 'Reconnect provider credentials.';
        const html = warning({ sync }).render();
        assert.match(html, /Saved progress/); assert.match(html, /1,317/);
        assert.match(html, /role="alert"/);
        assert.doesNotMatch(html, /spinning|Automatic synchronization will finish|Progress refreshes automatically/);
    }
});

test('completion hides counters and missing progress still explains active sync', () => {
    const sync = hosted();
    const view = warning({ sync }); view.render();
    assert.equal(view.render({ sync: { ...sync, status: 'idle', run: undefined, progress: null } }), '');
    const html = view.render({ sync: { ...sync, progress: null } });
    assert.match(html, /Preparing Git sync/);
    assert.doesNotMatch(html, /Processed in this phase/);
});
