import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as routes from '../lib/workspace-route.ts';
const { homeRoute, workspaceHref, parseWorkspaceRoute, WorkspaceNavigation } = routes;

function browser(href) {
    const events = new Map(), entries = [href];
    let index = 0;
    const host = {
        location: { pathname: '', search: '' },
        history: {
            state: { framework: true },
            pushState(data, unused, next) { assert.deepEqual(data, this.state); entries.splice(++index, Infinity, next); update(); },
            replaceState(data, unused, next) { assert.deepEqual(data, this.state); entries[index] = next; update(); },
        },
        addEventListener(name, listener) { events.set(name, listener); },
        removeEventListener(name, listener) { if (events.get(name) === listener) events.delete(name); },
        back() { if (index > 0) index--; update(); events.get('popstate')?.(); },
        forward() { if (index < entries.length - 1) index++; update(); events.get('popstate')?.(); },
        entries,
    };
    function update() { const url = new URL(entries[index], 'https://journey.local'); host.location.pathname = url.pathname; host.location.search = url.search; }
    update(); return host;
}

function moduleFrom(file, mocks, globals = {}) {
    const require = createRequire(import.meta.url);
    const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: name => mocks[name] ?? require(name), ...globals });
    return module.exports;
}
function hookFor(host) {
    return moduleFrom('../hooks/use-workspace-route.ts', {
        react: { useCallback: fn => fn, useSyncExternalStore: (subscribe, snapshot) => snapshot() },
        '@/lib/workspace-route': routes,
    }, { window: host }).useWorkspaceRoute;
}

test('repository, journey views and file names round-trip through shareable URLs', () => {
    const project = 'repo / % café', journey = 'journey #42';
    for (const tab of ['changesets', 'code', 'locks', 'inbox', 'review', 'agents', 'recording']) {
        const route = { project, journey, tab, mode: 'journey', path: tab === 'code' ? 'src/a #?%+名.ts' : '' };
        assert.deepEqual(parseWorkspaceRoute(workspaceHref(route)), route);
    }
    assert.equal(workspaceHref({ ...homeRoute, project: 'r' }), '/repositories/r');
    assert.equal(workspaceHref({ ...homeRoute, project: 'r', journey: 'j', tab: 'changesets', mode: 'journey' }), '/repositories/r/journeys/j');
    const mainWithinJourney = { ...homeRoute, project: 'r', journey: 'j', path: 'README.md' };
    assert.deepEqual(parseWorkspaceRoute(workspaceHref(mainWithinJourney)), mainWithinJourney);
});

test('unknown or malformed paths cannot silently become another workspace', () => {
    for (const href of ['/repositories', '/repositories/r/journeys', '/repositories/r/wat', '/repositories/r/journeys/j/settings', '/repositories/r/code/extra', '/repositories/%broken']) assert.equal(parseWorkspaceRoute(href), null, href);
});

test('browser Back and Forward restore repository, journey, view and exact file', () => {
    const host = browser('/repositories/first'), navigation = new WorkspaceNavigation(host);
    const states = [], unsubscribe = navigation.subscribe(() => states.push(navigation.read()));
    navigation.navigate({ journey: 'j', tab: 'review', mode: 'journey' });
    navigation.navigate({ tab: 'code', path: 'src/a.ts' });
    navigation.navigate({ ...homeRoute, project: 'second' });
    host.back(); assert.equal(navigation.read().path, 'src/a.ts'); assert.equal(navigation.read().journey, 'j');
    host.back(); assert.equal(navigation.read().tab, 'review'); assert.equal(navigation.read().project, 'first');
    host.forward(); assert.equal(navigation.read().tab, 'code'); assert.equal(navigation.read().path, 'src/a.ts');
    assert.equal(states.length, 6);
    unsubscribe(); host.back(); assert.equal(states.length, 6, 'unmounted listeners are removed');
});

test('actual route hook preserves direct links during project loading and supports all workspace controls', () => {
    const host = browser('/repositories/target/journeys/deep/review'), render = hookFor(host);
    assert.equal(render().selected, 'deep'); assert.equal(render().tab, 'review');
    render().setProject(current => current || 'first');
    assert.equal(host.entries.length, 1, 'loading repository list must not overwrite a requested deep link');
    render().setModeChoice({ project: 'target', mode: 'journey' });
    render().setTab('code');
    assert.equal(host.entries.length, 2, 'opening an editor adds exactly one history entry');
    render().setPathChoice({ project: 'target', path: 'src/深い name.ts' });
    assert.equal(render().pathChoice.path, 'src/深い name.ts');
    render().setProject('other');
    assert.equal(render().project, 'other'); assert.equal(render().selected, ''); assert.equal(render().tab, 'code');
    host.back(); assert.equal(render().project, 'target'); assert.equal(render().pathChoice.path, 'src/深い name.ts');
    render().setSelected('new-journey'); render().setTab('changesets');
    assert.equal(render().selected, 'new-journey'); assert.equal(render().modeChoice.mode, 'journey');
    assert.equal(render().pathChoice.path, '');
});

test('first repository selection replaces home and keeps explicit unavailable IDs for recovery', () => {
    const host = browser('/'), render = hookFor(host);
    render().setProject(current => current || 'first');
    assert.deepEqual(host.entries, ['/repositories/first']);
    const unavailable = hookFor(browser('/repositories/unknown/journeys/missing'));
    unavailable().setProject(current => current || 'first');
    assert.equal(unavailable().project, 'unknown'); assert.equal(unavailable().selected, 'missing');
});

test('settings Back link targets the same repository for both canonical and legacy URLs', () => {
    for (const href of ['/repositories/repo%20two/settings', '/settings?project=repo%20two']) {
        const render = hookFor(browser(href));
        const back = render().hrefFor({ journey: '', tab: 'code', mode: 'repository', path: '' });
        assert.equal(back, '/repositories/repo%20two');
        assert.equal(parseWorkspaceRoute(back).project, 'repo two');
        assert.equal(parseWorkspaceRoute(back).settings, undefined);
    }
    assert.equal(hookFor(browser('/?project=legacy'))().project, 'legacy');
});

test('journey anchors allow ordinary navigation and native modified clicks', () => {
    const host = browser('/repositories/r'), render = hookFor(host);
    let prevented = 0;
    const event = { button: 0, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() { prevented++; } };
    const target = { journey: 'j', tab: 'review', mode: 'journey' };
    render().followLink(event, target); assert.equal(prevented, 0); assert.equal(host.entries.length, 1);
    render().followLink({ ...event, metaKey: false }, target); assert.equal(prevented, 1); assert.equal(render().tab, 'review');
});

test('the actual server route renders direct repository and journey URLs and rejects unsupported views', async () => {
    const Workspace = () => null, RepositorySettings = () => null;
    const page = moduleFrom('../app/repositories/[project]/[[...view]]/page.tsx', {
        'next/navigation': { notFound() { throw new Error('404'); } },
        '@/app/page': { default: Workspace, __esModule: true }, '@/app/settings/page': { default: RepositorySettings, __esModule: true },
        '@/lib/workspace-route': routes,
    }).default;
    for (const view of [[], ['code'], ['journeys', 'j'], ['journeys', 'j', 'review']]) assert.equal((await page({ params: Promise.resolve({ project: 'repo', view }) })).type, Workspace);
    assert.equal((await page({ params: Promise.resolve({ project: 'repo', view: ['settings'] }) })).type, RepositorySettings);
    await assert.rejects(page({ params: Promise.resolve({ project: 'repo', view: ['unknown'] }) }), /404/);
});

test('the rendered settings return control crosses the page boundary with a native repository link', () => {
    const React = createRequire(import.meta.url)('react');
    const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server');
    for (const href of ['/repositories/exact/settings', '/settings?project=exact']) {
        const useWorkspaceRoute = hookFor(browser(href));
        const Settings = moduleFrom('../app/settings/page.tsx', {
            react: { ...React, useState: value => [value, () => {}], useEffect: () => {} },
            'next/link': { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) },
            'lucide-react': new Proxy({}, { get: () => () => null }),
            '@/components/ui/button': { Button: () => null }, '@/components/ui/switch': { Switch: () => null },
            '@/components/git-sync-settings': { GitSyncSettings: () => null },
            '@/lib/avc/core': { repositoryPolicy: () => ({}) }, './settings.module.css': { default: {} },
            '@/hooks/use-workspace-route': { useWorkspaceRoute },
        }).default;
        assert.match(renderToStaticMarkup(React.createElement(Settings)), /<a href="\/repositories\/exact"[^>]*>Back to workspace<\/a>/);
    }
});

test('settings hydration never exposes a Back link to the default repository', () => {
    const React = createRequire(import.meta.url)('react');
    const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server');
    const Settings = moduleFrom('../app/settings/page.tsx', {
        react: { ...React, useState: value => [value, () => {}], useEffect: () => {} },
        'next/link': { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) },
        'lucide-react': new Proxy({}, { get: () => () => null }),
        '@/components/ui/button': { Button: () => null }, '@/components/ui/switch': { Switch: () => null },
        '@/components/git-sync-settings': { GitSyncSettings: () => null },
        '@/lib/avc/core': { repositoryPolicy: () => ({}) }, './settings.module.css': { default: {} },
        '@/hooks/use-workspace-route': { useWorkspaceRoute: () => ({ project: '', hrefFor: () => '/' }) },
    }).default;
    const html = renderToStaticMarkup(React.createElement(Settings));
    assert.match(html, /<span[^>]*aria-disabled="true"[^>]*>Back to workspace<\/span>/);
    assert.doesNotMatch(html, /<a[^>]*>Back to workspace<\/a>/);
    assert.match(html, /<a href="\/"[^>]*><span><\/span>Journey<\/a>/, 'the deliberate brand Home link stays available');
});
