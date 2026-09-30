/**
 * Make Ctrl+C work for text selected inside a closed shadow root.
 *
 * Pages that listen for `copy` (attribution appenders, copy blockers) rebuild
 * the clipboard from `document.getSelection()`, which retargets a shadow
 * selection to the host and reads as empty. This fills the clipboard from the
 * shadow selection instead and keeps the event away from page listeners.
 *
 * Returns a cleanup function.
 */
export function enableShadowCopy(shadow: ShadowRoot): () => void {
  const onCopy = (event: Event) => {
    const text = shadowSelectionText(shadow);
    if (!text || !(event instanceof ClipboardEvent) || !event.clipboardData) {
      return;
    }
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    event.stopPropagation();
  };
  shadow.addEventListener('copy', onCopy);
  return () => shadow.removeEventListener('copy', onCopy);
}

/** Selected text when the selection lies entirely inside `shadow`, else ''. */
export function shadowSelectionText(shadow: ShadowRoot): string {
  const selection = document.getSelection();
  if (selection && typeof selection.getComposedRanges === 'function') {
    return selection
      .getComposedRanges({ shadowRoots: [shadow] })
      .map((staticRange) => {
        const { startContainer, endContainer } = staticRange;
        if (!shadow.contains(startContainer) || !shadow.contains(endContainer)) {
          return '';
        }
        const range = document.createRange();
        range.setStart(startContainer, staticRange.startOffset);
        range.setEnd(endContainer, staticRange.endOffset);
        return range.toString();
      })
      .join('');
  }
  // Chromium before getComposedRanges exposed the shadow selection here.
  const legacy = (shadow as ShadowRoot & { getSelection?: () => Selection | null })
    .getSelection?.();
  return legacy?.toString() ?? '';
}
