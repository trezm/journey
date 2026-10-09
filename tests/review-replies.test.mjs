import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { reviewReplyTarget } from '../lib/avc/review-target.ts';
import { reviewThreads, replyCommentTarget } from '../lib/review-threads.ts';
import { encodeState, decodeState } from '../lib/avc/state-codec.ts';

const parent = { id: 'parent', actor: 'human', kind: 'request_changes', body: 'What are these accounts?', revision: 'old', at: 1, changeset: 'cs', patch: 'patch', anchor: { path: 'file.ts', side: 'after', line: 2, context: 'value' } };
const reply = { ...parent, id: 'reply', kind: 'comment', replyTo: 'parent', actor: 'agent', body: 'Added an account table.', revision: 'current', at: 2 };
const nested = { ...reply, id: 'nested', replyTo: 'reply', body: 'Verified the order too.', at: 3 };
const code = expected => error => error.code === expected;

test('reply targets inherit context, reject foreign parents/conflicts and cannot change review decisions', () => {
    const j = { reviews: [parent, reply] };
    assert.deepEqual(reviewReplyTarget(j, { kind: 'comment', replyTo: 'reply' }), { replyTo: 'reply', changeset: 'cs', patch: 'patch', anchor: parent.anchor });
    assert.throws(() => reviewReplyTarget(j, { kind: 'comment', replyTo: 'missing' }), code('review_not_found'));
    for (const kind of ['approve', 'request_changes']) assert.throws(() => reviewReplyTarget(j, { kind, replyTo: 'parent' }), code('invalid_reply'));
    for (const changed of [{ changeset: 'other' }, { patch: 'other' }, { anchor: { ...parent.anchor, line: 3 } }, { anchor: null }])
        assert.throws(() => reviewReplyTarget(j, { kind: 'comment', replyTo: 'parent', ...changed }), code('invalid_reply_target'));
    assert.equal(parent.resolved, undefined);
    assert.deepEqual(replyCommentTarget({ id: 'journey', head: 'latest' }, parent, '  Answer  '), { journey: 'journey', revision: 'latest', replyTo: 'parent', body: 'Answer' });
});

test('thread grouping flattens descendants, sorts by time and keeps legacy prose and orphan replies visible', () => {
    const standalone = { ...parent, id: 'legacy', body: "Re: 'What are these accounts?' — fixed", at: 4 };
    const orphan = { ...reply, id: 'orphan', replyTo: 'missing', at: 5 };
    const groups = reviewThreads([nested, standalone, reply, parent, orphan]);
    assert.deepEqual(groups.map(group => group.root.id), ['parent', 'legacy', 'orphan']);
    assert.deepEqual(groups[0].replies.map(item => item.id), ['reply', 'nested']);
    assert.equal(reviewThreads([{ ...reply, replyTo: 'reply' }]).length, 1);
});

test('reply relationships survive persisted state round trips', () => {
    const state = { id: 'repo', leases: [], journeys: [{ reviews: [parent, reply, nested] }], receipts: {} };
    assert.deepEqual(decodeState(encodeState(state)), state);
});

test('shared component renders a compact thread, parent link, provenance and reply controls', () => {
    const require = createRequire(import.meta.url), ts = require('typescript');
    const compiled = ts.transpileModule(readFileSync(new URL('../components/review-threads.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const exports = {};
    new Function('require', 'exports', compiled)(name => {
        if (name === '@/lib/review-threads') return { reviewThreads, replyCommentTarget };
        if (name === '@/lib/comment-shortcut') return require('../lib/comment-shortcut.ts');
        if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => key }) };
        return require(name);
    }, exports);
    const html = renderToStaticMarkup(React.createElement(exports.ReviewThreads, { reviews: [parent, reply, nested], journey: { id: 'j', head: 'current' }, canComment: true, onComment: async () => true, context: () => React.createElement('a', { href: '#patch' }, 'Patch 12') }));
    assert.equal((html.match(/class="thread"/g) ?? []).length, 1);
    assert.equal((html.match(/class="reply"/g) ?? []).length, 2);
    assert.equal((html.match(/Patch 12/g) ?? []).length, 1);
    assert.equal((html.match(/>Reply<\/button>/g) ?? []).length, 3);
    assert.match(html, /title="Revision current"/);
    assert.match(html, /href="#[^"]+-reply" title="Added an account table\."/);
    assert.match(html, /What are these accounts\?/);
});
