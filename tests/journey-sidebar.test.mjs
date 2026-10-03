import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as helpers from '../lib/journey-list.ts';

const journeys = Array.from({ length: 23 }, (_, index) => ({
    id: `journey-${index}`, title: `Feature ${index}`, description: index === 4 ? 'Improve onboarding search' : '',
    created: index, status: index % 4 === 0 ? 'review' : index % 4 === 1 ? 'integrated' : index % 4 === 2 ? 'working' : 'abandoned',
}));

// Run the real rendered component and its event callbacks with persistent hook state.
function sidebar(initial = {}) {
    const require = createRequire(import.meta.url), state = [];
    let cursor = 0;
    const source = readFileSync(new URL('../components/journey-sidebar.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    const react = {
        ...React,
        useMemo: callback => callback(),
        useRef: () => ({ current: null }),
        useState: initialValue => {
            const index = cursor++;
            if (!(index in state)) state[index] = typeof initialValue === 'function' ? initialValue() : initialValue;
            return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
        },
    };
    runInNewContext(compiled, { module, exports: module.exports, require: name => {
        if (name === 'react') return react;
        if (name === '@/lib/journey-list') return helpers;
        if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        return require(name);
    } });
    const props = { journeys, selected: 'journey-22', hrefForJourney: id => `/repositories/repo/journeys/${id}`, onNavigateJourney: () => {}, ...initial };
    let tree;
    function render(changed = {}) { Object.assign(props, changed); cursor = 0; tree = module.exports.JourneySidebar(props); return renderToStaticMarkup(tree); }
    function find(predicate) {
        function walk(node) {
            if (!React.isValidElement(node)) return undefined;
            if (predicate(node)) return node;
            for (const child of React.Children.toArray(node.props.children)) { const found = walk(child); if (found) return found; }
        }
        const found = walk(tree);
        assert.ok(found, 'Expected control in rendered sidebar');
        return found.props;
    }
    return { render, find };
}

const control = (view, label) => view.find(node => node.props['aria-label'] === label);

test('sidebar renders newest ten journeys with navigable URLs and selected state', () => {
    const view = sidebar();
    const html = view.render();
    assert.equal((html.match(/class="journey-link/g) ?? []).length, 10);
    assert.ok(html.indexOf('Feature 22') < html.indexOf('Feature 21'));
    assert.doesNotMatch(html, />Feature 0</);
    assert.match(html, /href="\/repositories\/repo\/journeys\/journey-22"/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, /Newest first/);
    assert.equal(control(view, 'Previous journey page').disabled, true);
    assert.equal(control(view, 'Next journey page').disabled, false);
});

test('paging, searching, status changes and reset controls operate on rendered results', () => {
    const view = sidebar(); view.render();
    control(view, 'Next journey page').onClick();
    assert.match(view.render(), />Feature 12</);
    assert.doesNotMatch(view.render(), />Feature 22</);
    control(view, 'Search journeys').onChange({ target: { value: 'onboarding' } });
    let html = view.render();
    assert.match(html, />Feature 4</);
    assert.equal((html.match(/class="journey-link/g) ?? []).length, 1);
    assert.match(html, /1–1 of 1/);
    control(view, 'Filter journeys by status').onChange({ target: { value: 'integrated' } });
    html = view.render();
    assert.match(html, /No journeys match/);
    control(view, 'Clear journey filters').onClick();
    html = view.render();
    assert.match(html, />Feature 22</);
    assert.equal(control(view, 'Search journeys').value, '');
    assert.equal(control(view, 'Filter journeys by status').value, 'all');
    control(view, 'Next journey page').onClick(); view.render();
    control(view, 'Filter journeys by status').onChange({ target: { value: 'review' } });
    html = view.render();
    assert.match(html, />Feature 20</);
    assert.match(html, /1–6 of 6/);
});

test('the final page remains bounded when journeys disappear on refresh', () => {
    const view = sidebar(); view.render();
    control(view, 'Next journey page').onClick(); view.render();
    control(view, 'Next journey page').onClick();
    const html = view.render();
    assert.equal((html.match(/class="journey-link/g) ?? []).length, 3);
    assert.match(html, /21–23 of 23/);
    assert.equal(control(view, 'Next journey page').disabled, true);
    assert.equal(control(view, 'Previous journey page').disabled, false);
    const refreshed = view.render({ journeys: journeys.slice(0, 2) });
    assert.match(refreshed, /1–2 of 2/);
    assert.match(refreshed, />Feature 1</);
});

test('sidebar links retain the native navigation event, and new repositories start without old filters', () => {
    const calls = [], view = sidebar({ onNavigateJourney: (event, id) => calls.push({ event, id }) });
    view.render();
    const link = view.find(node => node.type === 'a' && node.props.href.endsWith('journey-22'));
    const event = { metaKey: true, button: 0 };
    link.onClick(event);
    assert.deepEqual(calls, [{ event, id: 'journey-22' }]);
    control(view, 'Search journeys').onChange({ target: { value: 'Feature 4' } });
    view.render();
    const otherRepository = sidebar({ journeys: [journeys[0]] });
    assert.match(otherRepository.render(), />Feature 0</);
    assert.equal(control(otherRepository, 'Search journeys').value, '');
});

test('an empty repository explains where journeys will appear without misleading page controls', () => {
    const view = sidebar({ journeys: [] });
    const html = view.render();
    assert.match(html, /Your feature journeys will appear here/);
    assert.doesNotMatch(html, /aria-label="Journey pages"/);
});
