import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../components/cli-install.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const Button = ({ children, ...props }) => { delete props.variant; return React.createElement('button', props, children); };

function component(react = React, globals = {}) {
    const componentModule = { exports: {} };
    runInNewContext(compiled, { module: componentModule, exports: componentModule.exports, ...globals, require: name => {
        if (name === 'react') return react;
        if (name === '@/components/ui/button') return { Button };
        if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
        return require(name);
    } });
    return componentModule.exports.CliInstall;
}

function browser(origin = 'https://journey.example.test:8443', clipboardAvailable = true) {
    const state = [], writes = [];
    let cursor = 0, tree, rejected = false;
    const CliInstall = component({
        ...React,
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useState: initial => {
            const index = cursor++;
            if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
            return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
        },
    }, {
        window: { location: { origin } },
        navigator: clipboardAvailable ? { clipboard: { writeText: async value => { writes.push(value); if (rejected) throw new Error('Clipboard permission denied.'); } } } : {},
    });
    function render() { cursor = 0; tree = CliInstall(); return renderToStaticMarkup(tree); }
    function find(predicate) {
        function visit(node) {
            if (!React.isValidElement(node)) return;
            if (predicate(node)) return node.props;
            for (const child of React.Children.toArray(node.props.children)) { const found = visit(child); if (found) return found; }
        }
        return visit(tree);
    }
    return { render, find, writes, rejectClipboard: value => { rejected = value; }, input: () => find(node => node.type === 'input'), copy: () => find(node => node.type === Button) };
}

test('server rendering offers a placeholder and disables copying before the browser origin is known', () => {
    // Use React's real server hooks with no browser globals: hydration must not
    // expose an incomplete relative curl command or attempt to read window.
    const html = renderToStaticMarkup(React.createElement(component()));
    assert.match(html, /placeholder="Preparing install command…"/);
    assert.match(html, /value=""/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Copy install command<\/button>/);
    assert.doesNotMatch(html, /curl -/);
    assert.match(html, /href="\/install\.sh"/);
});

test('browser installation commands use the current complete origin for both installer and CLI downloads', () => {
    for (const origin of ['https://journey.example.test:8443', 'http://127.0.0.1:5173']) {
        const view = browser(origin);
        view.render();
        assert.equal(view.input().value, `curl -fsSL '${origin}/install.sh' | bash -s -- --url '${origin}'`);
        assert.equal(view.copy().disabled, false);
        assert.equal(view.input().readOnly, true);
        assert.equal(view.input().spellCheck, false);
        assert.equal(view.find(node => node.type === 'label').htmlFor, view.input().id);
    }
});

test('focusing the read-only textbox selects the complete command for manual copying', () => {
    const view = browser();
    view.render();
    let selections = 0;
    view.input().onFocus({ currentTarget: { select: () => { selections++; } } });
    assert.equal(selections, 1);
    assert.equal(view.input().onChange, undefined);
});

test('Copy sends the exact visible command and confirms success after the clipboard resolves', async () => {
    const view = browser();
    view.render();
    const visible = view.input().value;
    await view.copy().onClick();
    assert.deepEqual(view.writes, [visible]);
    const html = view.render();
    assert.match(html, /Copied install command/);
    assert.doesNotMatch(html, /copy it manually/);
});

test('a clipboard rejection replaces prior success with manual-copy guidance and can recover', async () => {
    const view = browser();
    view.render();
    await view.copy().onClick();
    assert.match(view.render(), /Copied install command/);
    view.rejectClipboard(true);
    await view.copy().onClick();
    const failed = view.render();
    assert.match(failed, /role="status"[^>]*>Select the command above and copy it manually/);
    assert.doesNotMatch(failed, /Copied install command/);
    assert.equal(view.copy().disabled, false);
    assert.equal(view.input().value, view.writes[0]);
    view.rejectClipboard(false);
    await view.copy().onClick();
    const recovered = view.render();
    assert.match(recovered, /Copied install command/);
    assert.doesNotMatch(recovered, /copy it manually/);
});

test('browsers without the clipboard API retain a selectable command and manual fallback', async () => {
    const view = browser('http://127.0.0.1:5173', false);
    view.render();
    await view.copy().onClick();
    assert.match(view.render(), /Select the command above and copy it manually/);
    assert.equal(view.writes.length, 0);
    assert.equal(typeof view.input().onFocus, 'function');
    assert.match(view.input().value, /http:\/\/127\.0\.0\.1:5173\/install\.sh/);
});
