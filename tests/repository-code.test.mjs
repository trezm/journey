import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { LatestResource, codeRevision, codePath, repositorySelection } from '../lib/repository-code.ts';
import * as reviewHelpers from '../lib/avc/review.ts';
import * as requestHelpers from '../lib/avc/client.ts';
import { isCanonicalUpdate } from '../lib/avc/core.ts';

test('returning from settings selects only an owned repository and preserves valid workspace selection', () => {
    const projects = [{ id: 'first' }, { id: 'second' }];
    assert.equal(repositorySelection(projects, '', 'second'), 'second');
    assert.equal(repositorySelection(projects, 'first', 'second'), 'first');
    assert.equal(repositorySelection(projects, 'removed', 'second'), 'second');
    assert.equal(repositorySelection(projects, '', 'someone-elses-repo'), 'first');
    assert.equal(repositorySelection([], 'removed', 'second'), '');
});

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture() {
    const calls = [], states = [];
    const resource = new LatestResource((key, signal) => {
        const request = deferred();
        calls.push({ key, signal, ...request });
        return request.promise;
    }, state => states.push(state));
    return { resource, calls, states, latest: () => states.at(-1) };
}

test('repository code uses canonical head without a journey and requires explicit journey selection', () => {
    const state = { head: 'main' }, journey = { head: 'branch' };
    assert.equal(codeRevision(state, undefined, 'repository'), 'main');
    assert.equal(codeRevision(state, journey, 'repository'), 'main');
    assert.equal(codeRevision(state, journey, 'journey'), 'branch');
    assert.equal(codeRevision(null, undefined, 'repository'), undefined);
    assert.equal(codeRevision(state, undefined, 'journey'), 'main');
});

test('file selection survives revisions, falls back when removed, and accepts empty files', () => {
    assert.equal(codePath({ 'a.ts': '', 'README.md': 'hello' }, 'a.ts'), 'a.ts');
    assert.equal(codePath({ 'a.ts': '', 'README.md': 'hello' }, 'deleted.ts'), 'README.md');
    assert.equal(codePath({ 'b.ts': '', 'a.ts': '' }, ''), 'a.ts');
    assert.equal(codePath({}, 'old.ts'), '');
});

test('repository switching clears old data and ignores out-of-order results and stale errors', async () => {
    const { resource, calls, latest } = fixture();
    resource.select('A');
    const first = resource.load();
    resource.select('B');
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(latest().data, undefined);
    const second = resource.load();
    calls[1].resolve({ head: 'B-main' }); await second;
    calls[0].resolve({ head: 'A-main' }); await first;
    assert.equal(latest().key, 'B');
    assert.deepEqual(latest().data, { head: 'B-main' });
    resource.select('A');
    const oldFailure = resource.load();
    resource.select('B');
    const fresh = resource.load();
    calls[3].resolve({ head: 'B-new' }); await fresh;
    calls[2].reject(new Error('Revision is not part of this repository.')); await oldFailure;
    assert.equal(latest().error, '');
    assert.deepEqual(latest().data, { head: 'B-new' });
    await resource.load('A');
    assert.equal(calls.length, 4, 'old mutation reloads must not start another repository request');
});

test('overlapping reloads of the same repository keep only the latest response', async () => {
    const { resource, calls, latest } = fixture();
    resource.select('repo');
    const older = resource.load(), newer = resource.load();
    assert.equal(calls[0].signal.aborted, true);
    calls[1].resolve({ head: 'new' }); await newer;
    calls[0].resolve({ head: 'old' }); await older;
    assert.equal(latest().data.head, 'new');
    const refresh = resource.load();
    assert.equal(latest().data.head, 'new', 'background refresh keeps visible metadata');
    calls[2].resolve({ head: 'next' }); await refresh;
    assert.equal(latest().data.head, 'next');
});

test('revision switching ignores stale file snapshots, and load errors can be retried', async () => {
    const { resource, calls, latest } = fixture();
    resource.select('repo:main');
    const main = resource.load();
    resource.select('repo:branch');
    const branch = resource.load();
    calls[1].resolve({ files: { 'src/app.ts': 'journey code' } }); await branch;
    calls[0].resolve({ files: { 'src/app.ts': 'canonical code' } }); await main;
    assert.equal(latest().data.files['src/app.ts'], 'journey code');
    const failure = resource.load();
    calls[2].reject(new Error('Storage unavailable')); await failure;
    assert.equal(latest().status, 'error');
    assert.equal(latest().error, 'Storage unavailable');
    const retry = resource.load();
    calls[3].resolve({ files: {} }); await retry;
    assert.equal(latest().status, 'ready');
    assert.deepEqual(latest().data.files, {});
    resource.select('');
    assert.equal(latest().status, 'idle');
    assert.equal(latest().data, undefined);
});

// Exercise the actual workspace branch with a hydrated, imported repository
// that has no journeys. Mock only its data hooks and visual primitives.
function renderCodeWorkspace(options = {}) {
    const state = { id: 'repo', name: 'journey', head: 'main', journeys: options.journeys ?? [], leases: [], events: [], waiting: [], ...options.state };
    const require = createRequire(import.meta.url);
    const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    let index = 0;
    const initial = [{ id: 'user', name: 'Reader' }, false, [{ id: 'repo', name: 'journey' }], options.draft ?? { revision: '', path: '', content: '' }];
    const testModule = { exports: {} };
    const mockRequire = name => {
        if (name === 'react') return { ...React, useState: value => { const at = index++; return [at < initial.length ? initial[at] : value, next => options.onState?.(at, next)]; }, useEffect: (effect, dependencies) => options.onEffect?.(effect, dependencies), useCallback: callback => callback };
        if (name === '@/hooks/use-repository') return {
            useRepository: () => ({ state, setState: options.setRepositoryState ?? (() => {}), reload: options.reload ?? (async () => {}), status: 'ready', error: '' }),
            useRepositoryFiles: () => ({ key: 'repo:main', status: 'ready', error: '', files: { 'README.md': 'Imported repository code' }, reload: async () => {} }),
        };
        if (name === '@/components/journey-sidebar') return { JourneySidebar: () => null };
        if (name === '@/components/git-sync-warning') return { GitSyncWarning: () => null };
        if (name === '@/hooks/use-workspace-route') return { useWorkspaceRoute: () => ({ project: 'repo', selected: options.selected ?? '', tab: options.tab ?? 'code', modeChoice: { project: 'repo', mode: options.mode ?? 'repository' }, pathChoice: { project: 'repo', path: 'README.md' }, setProject: () => {}, setSelected: () => {}, setTab: () => {}, setModeChoice: () => {}, setPathChoice: () => {}, hrefFor: () => '/repositories/repo', followLink: () => {} }) };
        if (name === '@/lib/repository-code') return { codeRevision, codePath, repositorySelection };
        if (name === '@/lib/avc/review') return reviewHelpers;
        if (name === '@/lib/avc/core') return { isCanonicalUpdate };
        if (name === '@/lib/avc/client') return { ...requestHelpers, jsonFetch: options.requestJson ?? requestHelpers.jsonFetch };
        if (name === '@/components/patch-viewer') return { PatchViewer: () => null };
        if (name === '@/components/repository-code-panel') return { RepositoryCodePanel: props => React.createElement('pre', { 'data-revision': props.revision }, props.content) };
        if (name === '@/components/repository-picker') return { RepositoryPicker: () => null };
        if (name === '@/components/ui/button') return { Button: ({ children, ...props }) => { options.onButton?.({ children, ...props }); return React.createElement('button', props, children); } };
        if (name === '@/components/ui/dialog') return { Dialog: () => null, DialogContent: () => null, DialogTitle: () => null, DialogDescription: () => null };
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        return require(name);
    };
    runInNewContext(compiled, { module: testModule, exports: testModule.exports, require: mockRequire, Date, setInterval, clearInterval, crypto: globalThis.crypto });
    return renderToStaticMarkup(React.createElement(testModule.exports.default));
}
test('the Workspace Code tab renders repository files without creating a journey', () => {
    const html = renderCodeWorkspace();
    assert.match(html, /data-revision="main"/);
    assert.match(html, /Imported repository code/);
    assert.doesNotMatch(html, /One feature\. One journey\./);
});

test('unpublished drafts do not appear in main or another journey at the same revision', () => {
    const journeys = ['j1', 'j2'].map(id => ({ id, head: 'main', changesets: [], manifest: [], status: 'working' }));
    const draft = { revision: 'repo:main:j1', path: 'README.md', content: 'Unpublished journey draft' };
    const canonical = renderCodeWorkspace({ journeys, selected: 'j1', draft });
    assert.match(canonical, /Imported repository code/);
    assert.doesNotMatch(canonical, /Unpublished journey draft/);
    const isolated = renderCodeWorkspace({ journeys, selected: 'j1', mode: 'journey', draft });
    assert.match(isolated, /Unpublished journey draft/);
    const other = renderCodeWorkspace({ journeys, selected: 'j2', mode: 'journey', draft });
    assert.match(other, /Imported repository code/);
    assert.doesNotMatch(other, /Unpublished journey draft/);
});

test('workspace mutations refresh metadata through the repository-scoped loader', async () => {
    const calls = [];
    let submit;
    const journey = { id: 'j1', head: 'branch', base: 'main', created: 0, changesets: [], manifest: [], reviews: [], status: 'working' };
    renderCodeWorkspace({
        journeys: [journey], selected: 'j1', tab: 'changesets',
        requestJson: async (url, init) => {
            assert.equal(url, '/api/avc');
            assert.equal(init.method, 'POST');
            assert.equal(JSON.parse(init.body).action, 'submit');
            calls.push('mutation');
            return { result: { submitted: true } };
        },
        reload: async () => { calls.push('repository reload'); },
        setRepositoryState: () => { assert.fail('Mutation responses must not bypass the repository-scoped loader.'); },
        onButton: props => { if (React.Children.toArray(props.children).includes('Submit for review')) submit = props.onClick; },
    });
    assert.equal(typeof submit, 'function');
    await submit();
    assert.deepEqual(calls, ['mutation', 'repository reload']);
});

test('an unavailable journey deep link does not display a different journey or repository revision', () => {
    const html = renderCodeWorkspace({ selected: 'missing' });
    assert.match(html, /Journey not found/);
    assert.doesNotMatch(html, /Imported repository code/);
});

test('Integrate button requires a current authorized approval even when worker approval is optional', () => {
    const approval = { id: 'approval', kind: 'approve', revision: 'head', authority: 'human', body: 'Reviewed', at: 0 };
    for (const [label, reviews, allowCoordinatorApproval, disabled] of [
        ['missing', [], false, true],
        ['old revision', [{ ...approval, revision: 'old' }], false, true],
        ['revoked', [{ ...approval, resolved: true }], false, true],
        ['disallowed coordinator', [{ ...approval, authority: 'coordinator' }], false, true],
        ['allowed coordinator', [{ ...approval, authority: 'coordinator' }], true, false],
        ['current owner', [approval], false, false],
    ]) {
        let integrate;
        const journey = { id: 'j', head: 'head', status: 'review', changesets: [], reviews, manifest: [], manifestDeclared: true };
        renderCodeWorkspace({
            selected: 'j', tab: 'review', journeys: [journey],
            state: { requireApproval: false, allowCoordinatorApproval, leases: [{ journey: 'j', retained: true, token: 'token' }] },
            onButton: button => { if (button.className?.includes('integrate-button')) integrate = button; },
        });
        assert.equal(integrate?.disabled, disabled, label);
    }
});


test('direct journey links initialize editing state after metadata arrives without resetting it on polling', () => {
    const updates = [];
    let previous;
    const options = {
        selected: 'deep-linked',
        onState: (index, value) => updates.push(value),
        onEffect: (effect, dependencies) => {
            if (dependencies?.[0] !== 'deep-linked') return;
            if (!previous || dependencies.some((value, index) => value !== previous[index])) effect();
            previous = dependencies;
        },
    };
    renderCodeWorkspace({ ...options, journeys: [] });
    updates.length = 0;
    const journey = { id: 'deep-linked', head: 'head', status: 'working', changesets: [{ id: 'initial-changeset' }], manifest: [{ target: 'api' }] };
    renderCodeWorkspace({ ...options, journeys: [journey] });
    assert.ok(updates.includes('initial-changeset'), 'the loaded changeset is available to Acquire lock');
    assert.ok(updates.includes(journey.manifest), 'the existing declaration loads with the journey');
    updates.length = 0;
    renderCodeWorkspace({ ...options, journeys: [{ ...journey, changesets: [{ id: 'another-changeset' }] }] });
    assert.equal(updates.length, 0, 'background refresh preserves a user-selected changeset');
});
