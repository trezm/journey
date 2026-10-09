import type { KeyboardEvent } from 'react';

/** Use the existing submit path so keyboard and button actions share validation. */
export function submitCommentOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>, submit?: () => void) {
    if (event.defaultPrevented || event.key !== 'Enter' || !event.metaKey || event.altKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    if (event.repeat || event.currentTarget.disabled || !event.currentTarget.value.trim()) return;
    if (submit) submit();
    else event.currentTarget.form?.requestSubmit();
}
