import test from 'node:test';
import assert from 'node:assert/strict';
import { submitCommentOnShortcut } from '../lib/comment-shortcut.ts';

function keyEvent(overrides = {}) {
    let prevented = 0, submitted = 0;
    const event = {
        key: 'Enter', metaKey: true, altKey: false, shiftKey: false, repeat: false,
        nativeEvent: { isComposing: false, keyCode: 13 },
        currentTarget: { disabled: false, value: 'Edited draft', form: { requestSubmit() { submitted++; } } },
        preventDefault() { prevented++; }, ...overrides,
    };
    return { event, result: () => ({ prevented, submitted }) };
}

test('Command+Enter invokes normal form submission and consumes the newline', () => {
    const key = keyEvent();
    submitCommentOnShortcut(key.event);
    assert.deepEqual(key.result(), { prevented: 1, submitted: 1 });
});

test('review composer uses its existing comment button instead of other review actions', () => {
    const key = keyEvent();
    let clicks = 0;
    submitCommentOnShortcut(key.event, () => { clicks++; });
    assert.equal(clicks, 1);
    assert.deepEqual(key.result(), { prevented: 1, submitted: 0 });
});

test('plain Enter, other keys, modified Enter, and IME confirmation remain untouched', () => {
    for (const override of [{ metaKey: false }, { key: 'x' }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
        const key = keyEvent(override);
        submitCommentOnShortcut(key.event);
        assert.deepEqual(key.result(), { prevented: 0, submitted: 0 });
    }
});

test('held shortcut, pending disabled textarea, and whitespace drafts do not post', () => {
    for (const override of [{ repeat: true }, { currentTarget: { disabled: true, value: 'Draft' } }, { currentTarget: { value: ' \n ' } }]) {
        const key = keyEvent(override);
        let calls = 0;
        submitCommentOnShortcut(key.event, () => { calls++; });
        assert.equal(calls, 0);
        assert.deepEqual(key.result(), { prevented: 1, submitted: 0 });
    }
});
