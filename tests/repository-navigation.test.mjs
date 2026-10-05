import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { homeRoute, nextWorkspaceRoute, workspaceHref } from '../lib/workspace-route.ts';
import * as journeyList from '../lib/journey-list.ts';
function component(file, name) {
    const require = createRequire(import.meta.url), module = { exports: {} };
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    runInNewContext(code, { module, exports: module.exports, require: name => {
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        if (name === '@/lib/journey-list') return journeyList;
        if (name === '@/components/ui/button') return { Button: ({ children }) => React.createElement('button', null, children) };
        if (name === '@/components/syntax-code') return { SyntaxSource: () => null };
        return require(name);
    } });
    return module.exports[name];
}
test('repository primary links escape detail scope and code view links preserve file choice', () => {
    const Navigation = component('../components/repository-navigation.tsx', 'RepositoryNavigation');
    for (const route of [{ ...homeRoute, project: 'r', journey: 'j', changeset: 'c', tab: 'changesets' }, { ...homeRoute, project: 'r', path: 'README.md' }]) {
        const html = renderToStaticMarkup(React.createElement(Navigation, { selected: route.journey, tab: route.tab, hrefFor: update => workspaceHref(nextWorkspaceRoute(route, update)), followLink() {} }));
        assert.match(html, /href="\/repositories\/r\/journeys"/);
        assert.match(html, /href="\/repositories\/r"/);
        assert.doesNotMatch(html, /changesets\/c/);
        if (route.journey) assert.doesNotMatch(html, /Code views/);
        else { assert.match(html, /Source tree/); assert.match(html, /href="\/repositories\/r\/live"/); }
    }
});
test('journeys index provides deep links and preserves bounded pagination for large repositories', () => {
    const Index = component('../components/journeys-index.tsx', 'JourneysIndex');
    const journeys = Array.from({ length: 23 }, (_, i) => ({ id: `j${i}`, title: `Feature ${i}`, description: '', status: 'working', created: i, changesets: [] }));
    const html = renderToStaticMarkup(React.createElement(Index, { journeys, hrefForJourney: id => `/repositories/r/journeys/${id}`, onNavigateJourney() {} }));
    assert.equal((html.match(/class="journeys-row"/g) ?? []).length, 10);
    assert.match(html, /href="\/repositories\/r\/journeys\/j22"/);
    assert.match(html, /1–10 of 23/);
    assert.match(html, /Search journeys/);
    assert.match(html, /Filter journeys by status/);
});
test('source tree groups nested files and marks the exact selected file', () => {
    const Code = component('../components/repository-code-panel.tsx', 'RepositoryCodePanel');
    const html = renderToStaticMarkup(React.createElement(Code, { mode: 'repository', files: { 'src/a.ts': 'a', 'src/lib/b.ts': 'b', 'README.md': '' }, path: 'src/lib/b.ts', status: 'ready', leases: [], error: '', content: 'b' }));
    assert.match(html, /aria-label="Source tree"/);
    assert.match(html, /<summary>src<\/summary>/);
    assert.match(html, /<summary>lib<\/summary>/);
    assert.match(html, /title="src\/lib\/b.ts" aria-current="page"/);
});
