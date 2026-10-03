import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { highlightCode, languageForFile } from '../lib/syntax-highlight.ts';

const sourceText = highlighted => highlighted.lines.map(line => line.map(token => token.value).join('')).join('\n');

test('filenames, aliases, and script shebangs choose familiar language grammars', () => {
    const files = {
        'src/App.TSX': 'typescript', 'src/index.mjs': 'javascript', 'src/main.rs': 'rust',
        'src/main.py': 'python', 'src/main.go': 'go', 'src/main.rb': 'ruby', 'src/Main.java': 'java',
        'src/main.cpp': 'cpp', 'src/main.cs': 'csharp', 'src/main.swift': 'swift', 'src/main.kt': 'kotlin',
        'index.html': 'xml', 'style.css': 'css', 'style.scss': 'scss', 'api.graphql': 'graphql',
        'query.sql': 'sql', 'package.json': 'json', 'ci.yaml': 'yaml', 'Cargo.toml': 'ini',
        'README.md': 'markdown', 'Makefile': 'makefile', '.bashrc': 'bash', '.editorconfig': 'ini',
    };
    for (const [file, language] of Object.entries(files)) assert.equal(languageForFile(file), language, file);
    assert.equal(languageForFile('scripts/check', '#!/usr/bin/env python3\nprint(1)'), 'python');
    assert.equal(languageForFile('scripts/check', '#!/usr/bin/python3.12\nprint(1)'), 'python');
    assert.equal(languageForFile('scripts/run', '#!/usr/bin/env -S node --experimental-strip-types\nconst x = 1;'), 'javascript');
    assert.equal(languageForFile('scripts/run', '#!/bin/bash\necho hello'), 'bash');
    assert.equal(languageForFile('notes.txt', '#!/bin/bash\nThis is documentation.'), null);
});

test('several languages produce grammar tokens without altering source text', () => {
    const files = {
        'App.tsx': 'export const App = () => <div>Hello</div>;\n',
        'lib.py': 'def greet(name):\n    return "hello " + name\n',
        'main.rs': 'pub fn main() { println!("hello"); }',
        'main.go': 'package main\nfunc main() { println("hello") }',
        'index.html': '<script>const message = "hello";</script>',
        'style.css': '.hello { color: red; }',
        'config.yaml': 'name: hello\ncount: 4\n',
        'Cargo.toml': '[package]\nname = "journey"',
        'data.json': '{"hello": true}',
        'query.sql': 'SELECT name FROM users WHERE active = true;',
        'README.md': '# Hello\n**world**\n',
    };
    for (const [path, source] of Object.entries(files)) {
        const result = highlightCode(path, source);
        assert.equal(sourceText(result), source, path);
        assert.ok(result.lines.flat().some(token => token.classes.length), `Expected colored tokens for ${path}`);
    }
});

test('full-file grammar state preserves multiline comments, strings, and blank lines for diff slicing', () => {
    const comment = highlightCode('a.ts', '/* first\n\nlast */\nconst count = 1;\n');
    assert.equal(comment.lines.length, 5);
    assert.deepEqual(comment.lines[1], []);
    assert.ok(comment.lines[2].every(token => token.classes.includes('hljs-comment')));
    assert.ok(comment.lines[3].some(token => token.value === 'const' && token.classes.includes('hljs-keyword')));
    const string = highlightCode('a.py', 'value = """first\nsecond\nthird"""\n');
    assert.ok(string.lines[1].every(token => token.classes.includes('hljs-string')));
    assert.equal(sourceText(string), 'value = """first\nsecond\nthird"""\n');
});

test('unknown, empty, oversized and minified files remain exact plaintext', () => {
    for (const [path, source] of [
        ['notes.unknown', '<img src=x onerror=alert(1)>\r\n\t& text\n'],
        ['empty.ts', ''], ['large.ts', 'const value = 1;\n'.repeat(7000)],
        ['minified.js', 'let value = "' + 'x'.repeat(11000) + '";'],
    ]) {
        const result = highlightCode(path, source);
        assert.equal(sourceText(result), source);
        assert.ok(result.lines.flat().every(token => token.classes.length === 0));
    }
});

function components() {
    const require = createRequire(import.meta.url);
    const source = readFileSync(new URL('../components/syntax-code.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const testModule = { exports: {} };
    runInNewContext(compiled, {
        module: testModule, exports: testModule.exports,
        require: name => name === '@/lib/syntax-highlight' ? { highlightCode } : name.endsWith('.module.css') ? { default: new Proxy({}, { get: (_, key) => String(key) }) } : require(name),
    });
    return testModule.exports;
}

test('token rendering escapes repository markup and exposes a labeled, editable textarea only in edit mode', () => {
    const { SyntaxLine, SyntaxSource } = components();
    const source = '<img src=x onerror=alert(1)>';
    const line = renderToStaticMarkup(React.createElement(SyntaxLine, { tokens: highlightCode('notes.txt', source).lines[0] }));
    assert.match(line, /&lt;img/);
    assert.doesNotMatch(line, /<img/);
    const view = renderToStaticMarkup(React.createElement(SyntaxSource, { path: 'notes.txt', source }));
    assert.match(view, /aria-label="Read notes.txt"/);
    assert.match(view, /Plain text/);
    assert.doesNotMatch(view, /<textarea/);
    const editor = renderToStaticMarkup(React.createElement(SyntaxSource, { path: 'notes.txt', source, editable: true }));
    assert.match(editor, /<pre[^>]+aria-hidden="true"/);
    assert.match(editor, /<textarea[^>]+aria-label="Edit notes.txt"/);
    assert.match(editor, /&lt;img/);
    assert.doesNotMatch(editor, /<img/);
});
