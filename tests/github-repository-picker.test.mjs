import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

function picker(send) {
    const require = createRequire(import.meta.url), state = [], effects = [], cleanups = [], requests = [];
    let cursor = 0, tree;
    const source = readFileSync(new URL('../components/git-sync-settings.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const componentModule = { exports: {} };
    runInNewContext(compiled, { module: componentModule, exports: componentModule.exports, URLSearchParams, AbortController, setInterval: () => 1, clearInterval() {}, window: { location: { search: '' } }, fetch: async url => {
        requests.push(url);
        if (url.startsWith('/api/sync')) return Response.json({ head: 'a'.repeat(40), user: { agent: false } });
        const parsed = new URL(url, 'https://journey.test');
        if (!parsed.searchParams.has('repos') && !parsed.searchParams.has('owners')) return Response.json({ configured: true, connection: { username: 'alice' } });
        return send(parsed);
    }, require: name => {
        if (name === 'react') return { ...React, useState: initial => {
            const index = cursor++;
            if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
            return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
        }, useRef: initial => { const index = cursor++; return state[index] ??= { current: initial }; }, useEffect: effect => { const index = cursor++; if (!(index in state)) { state[index] = true; effects.push(effect); } } };
        if (name === '@/components/ui/button') return { Button: props => React.createElement('button', props) };
        if (name === '@/components/ui/switch') return { Switch: () => null };
        if (name === '@/components/git-sync-warning') return { GitSyncWarning: () => null };
        if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        return require(name);
    } });
    function render() { cursor = 0; const outer = componentModule.exports.GitSyncSettings({ project: 'repo' }); tree = outer.type(outer.props); return renderToStaticMarkup(tree); }
    function find(predicate) {
        function walk(node) {
            if (!React.isValidElement(node)) return;
            if (predicate(node)) return node.props;
            for (const child of React.Children.toArray(node.props.children)) { const found = walk(child); if (found) return found; }
        }
        return walk(tree);
    }
    async function settle() { await new Promise(resolve => setImmediate(resolve)); return render(); }
    async function mount() { render(); for (const effect of effects.splice(0)) cleanups.push(effect()); return settle(); }
    const button = text => find(node => node.props.children === text);
    return { render, find, button, settle, mount, requests, unmount: () => cleanups.forEach(fn => fn?.()) };
}
const owners = { owners: [{ login: 'alice', kind: 'personal' }, { login: 'team', kind: 'organization' }], nextOwnerPage: null };
const repo = (name, branch = 'main') => ({ id: name, name, remote: `https://github.com/${name}.git`, branch, private: true });

test('GitHub asks for an organization/account before repositories and applies the selected repository branch', async () => {
    const view = picker(async url => Response.json(url.searchParams.has('owners') ? owners : { repositories: [repo('team/app', 'develop')], nextPage: null }));
    await view.mount(); view.button('Choose repository').onClick(); await view.settle();
    assert.match(view.render(), /GitHub organization or account/); assert.equal(view.requests.filter(url => url.includes('repos=')).length, 0);
    view.find(node => node.props.id === 'github-owner').onChange({ target: { value: 'team' } }); await view.settle();
    assert(view.requests.at(-1).includes('owner=team'));
    view.find(node => node.props.id === 'provider-repository').onChange({ target: { value: 'https://github.com/team/app.git' } }); view.render();
    assert.equal(view.find(node => node.props.id === 'sync-remote').value, 'https://github.com/team/app.git');
    assert.equal(view.find(node => node.props.id === 'sync-branch').value, 'develop'); view.unmount();
});

test('changing account ignores late responses and clears the previous repository choices', async () => {
    let resolveOld;
    const view = picker(async url => {
        if (url.searchParams.has('owners')) return Response.json(owners);
        if (url.searchParams.get('owner') === 'team') return new Promise(resolve => { resolveOld = resolve; });
        return Response.json({ repositories: [repo('alice/app')], nextPage: null });
    });
    await view.mount(); view.button('Choose repository').onClick(); await view.settle();
    view.find(node => node.props.id === 'github-owner').onChange({ target: { value: 'team' } }); view.render();
    view.find(node => node.props.id === 'github-owner').onChange({ target: { value: 'alice' } }); await view.settle();
    resolveOld(Response.json({ repositories: [repo('team/late')], nextPage: 2 })); await view.settle();
    assert.match(view.render(), /alice\/app/); assert.doesNotMatch(view.render(), /team\/late/); assert.equal(view.button('Load more repositories'), undefined); view.unmount();
});

test('empty filtered pages keep pagination available and provider failures retry the selection', async () => {
    let failed = false;
    const view = picker(async url => {
        if (url.searchParams.has('owners')) return Response.json(owners);
        if (url.searchParams.get('page') === '1') return Response.json({ repositories: [], nextPage: 2 });
        if (!failed) { failed = true; return Response.json({ error: 'Reconnect GitHub.' }, { status: 403 }); }
        return Response.json({ repositories: [repo('team/second')], nextPage: null });
    });
    await view.mount(); view.button('Choose repository').onClick(); await view.settle();
    view.find(node => node.props.id === 'github-owner').onChange({ target: { value: 'team' } }); await view.settle();
    assert.match(view.render(), /No writable repositories found on this page/);
    view.button('Load more repositories').onClick(); await view.settle(); assert.match(view.render(), /Reconnect GitHub/);
    view.button('Retry selection').onClick(); await view.settle(); assert.match(view.render(), /team\/second/); assert.equal(view.button('Load more repositories'), undefined); view.unmount();
});

test('organization pagination preserves earlier accounts and never fetches repositories implicitly', async () => {
    const view = picker(async url => Response.json(url.searchParams.get('page') === '1' ? { ...owners, nextOwnerPage: 2 } : { owners: [{ login: 'later', kind: 'organization' }], nextOwnerPage: null }));
    await view.mount(); view.button('Choose repository').onClick(); await view.settle();
    view.button('Load more organizations').onClick(); await view.settle();
    assert.match(view.render(), /alice \(personal account\)/); assert.match(view.render(), /later \(organization\)/);
    assert.equal(view.requests.filter(url => url.includes('repos=')).length, 0); view.unmount();
});

test('switching to GitLab lists personal repositories directly and ignores pending GitHub organizations', async () => {
    let resolveOwners;
    const view = picker(async url => {
        if (url.searchParams.has('owners')) return new Promise(resolve => { resolveOwners = resolve; });
        assert.equal(url.pathname, '/api/oauth/gitlab'); assert.equal(url.searchParams.has('owner'), false);
        return Response.json({ repositories: [{ ...repo('alice/gitlab'), remote: 'https://gitlab.com/alice/gitlab.git' }], nextPage: null });
    });
    await view.mount(); view.button('Choose repository').onClick(); view.render();
    const gitlab = view.find(node => node.type === 'div' && Array.isArray(node.props.children) && node.props.children[0]?.props?.children === 'GitLab');
    React.Children.toArray(gitlab.children).find(node => node.props.children === 'Choose repository').props.onClick(); await view.settle();
    resolveOwners(Response.json(owners)); await view.settle();
    assert.match(view.render(), /alice\/gitlab/); assert.doesNotMatch(view.render(), /id="github-owner"/); view.unmount();
});
