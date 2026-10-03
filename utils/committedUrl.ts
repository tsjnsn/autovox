/**
 * Calls `onChange` once the document's URL has actually changed.
 *
 * The Navigation API's `navigate` event fires before a navigation commits, and
 * also for downloads, 204 responses and cancelled navigations that leave the
 * page where it is. `currententrychange` fires only after a same-document
 * navigation commits; a cross-document one replaces this script anyway.
 */
export function watchCommittedUrl(
  navigation: Pick<EventTarget, 'addEventListener'>,
  currentUrl: () => string,
  onChange: () => void,
  signal: AbortSignal,
): void {
  let seen = currentUrl();
  navigation.addEventListener(
    'currententrychange',
    () => {
      const url = currentUrl();
      if (url === seen) return;
      seen = url;
      onChange();
    },
    { signal },
  );
}
