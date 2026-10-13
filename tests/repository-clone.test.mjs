import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { repositoryCloneUrl, repositoryCloneCommand, copyCloneText } from '../lib/repository-clone.ts';

test('clone links use the actual Git endpoint without origin credentials, query or page path', () => {
    assert.equal(repositoryCloneUrl('https://user:secret@example.com/repositories/repo?token=secret#fragment', 'repo'), 'https://example.com/api/git/repo/');
    assert.equal(repositoryCloneUrl('http://localhost:5173', 'repo'), 'http://localhost:5173/api/git/repo/');
    assert.equal(repositoryCloneUrl('', 'repo'), '');
    assert.equal(repositoryCloneUrl('https://example.com', ''), '');
    assert.throws(() => repositoryCloneUrl('javascript:alert(1)', 'repo'), /protocol/);
});

test('clone commands safely pass unusual project names as a single URL argument', () => {
    const url = repositoryCloneUrl('https://example.com', "repo'$(printf injected); space");
    for (const isPublic of [true, false]) {
        const command = repositoryCloneCommand(url, isPublic);
        const script = 'git() { printf "%s\\n" "$@"; }; ' + command;
        const args = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
        assert.deepEqual(args, isPublic ? ['clone', url] : ['-c', 'credential.username=journey', 'clone', url]);
        assert.doesNotMatch(command, /password|avc_|Authorization/);
    }
    assert.equal(repositoryCloneCommand('', false), '');
});

test('clipboard success and denial report actual result and never throw', async () => {
    const values = [];
    assert.equal(await copyCloneText('url', { writeText: async value => { values.push(value); } }), true);
    assert.deepEqual(values, ['url']);
    assert.equal(await copyCloneText('url', undefined), false);
    assert.equal(await copyCloneText('url', { writeText: async () => { throw new Error('permission denied'); } }), false);
});

test('both repository homes expose clone; public mode requires no credentials', () => {
    const publicHome = readFileSync(new URL('../components/public-repository.tsx', import.meta.url), 'utf8');
    const ownerHome = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
    assert.match(publicHome, /<RepositoryClone project=\{repository.id\} isPublic\/>/);
    assert.match(ownerHome, /<RepositoryClone key=\{project\} project=\{project\} isPublic=\{repository\?\.visibility === 'public'\}/);
});

// Run the actual component handlers with deterministic hooks and UI primitives.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
function cloneMenu(isPublic, clipboard, onCredentials = () => {}) {
    const require = createRequire(import.meta.url), hooks = [];
    let index = 0, popover, buttons = [];
    const source = readFileSync(new URL('../components/repository-clone.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const testModule = { exports: {} };
    const mockRequire = name => {
        if (name === 'react') return { ...React, useId: () => 'clone', useState: initial => { const at = index++; if (!(at in hooks)) hooks[at] = initial; return [hooks[at], value => { hooks[at] = value; }]; } };
        if (name === '@/lib/repository-clone') return { repositoryCloneUrl, repositoryCloneCommand, copyCloneText };
        if (name === './ui/button') return { Button: props => { buttons.push(props); return React.createElement('button', props, props.children); } };
        if (name === './ui/popover') return {
            Popover: props => { popover = props; return React.createElement('div', null, props.children); },
            PopoverTrigger: props => props.children,
            PopoverContent: props => React.createElement('section', { 'aria-labelledby': props['aria-labelledby'] }, props.children),
        };
        if (name.endsWith('.css')) return { default: {} };
        return require(name);
    };
    runInNewContext(compiled, { require: mockRequire, module: testModule, exports: testModule.exports, window: { location: { origin: 'https://example.com' } }, navigator: { clipboard } });
    const render = () => { index = 0; buttons = []; return renderToStaticMarkup(React.createElement(testModule.exports.RepositoryClone, { project: 'repo', isPublic, onCredentials })); };
    render(); popover.onOpenChange(true); render();
    return { render, buttons: () => buttons, isOpen: () => popover.open };
}

test('public menu copies a usable command and announces success only after clipboard write', async () => {
    const written = [], menu = cloneMenu(true, { writeText: async value => { written.push(value); } });
    const markup = menu.render();
    assert.match(markup, /No sign-in required/);
    assert.doesNotMatch(markup, /account password/);
    menu.buttons().find(button => String(button.children).includes('Copy clone command')).onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(written, ["git clone 'https://example.com/api/git/repo/'"]);
    assert.match(menu.render(), /Command copied/);
});

test('private menu gives token instructions and clipboard denial leaves manual-copy fallback', async () => {
    const menu = cloneMenu(false, { writeText: async () => { throw new Error('denied'); } });
    assert.match(menu.render(), /repository agent token/);
    assert.match(menu.render(), /credential.username=journey/);
    menu.buttons().find(button => button['aria-label'] === 'Copy repository URL').onClick();
    await new Promise(resolve => setImmediate(resolve));
    const result = menu.render();
    assert.match(result, /role="alert"/);
    assert.match(result, /copy it manually/);
    assert.doesNotMatch(result, /URL copied/);
});


test('opening credential settings closes the clone popup', () => {
    let navigated = false;
    const menu = cloneMenu(false, undefined, () => { navigated = true; });
    assert.equal(menu.isOpen(), true);
    menu.buttons().find(button => button.children === 'Open Connect & import').onClick();
    menu.render();
    assert.equal(navigated, true);
    assert.equal(menu.isOpen(), false);
});
