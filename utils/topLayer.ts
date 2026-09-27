/**
 * Keep an element above, and clickable over, all page content.
 *
 * z-index alone loses to page elements in the browser's top layer (modal
 * <dialog>s, popovers, fullscreen) and ties at max z-index go to whatever is
 * later in the DOM. A manual popover lives in the top layer itself, and the
 * top layer paints in insertion order, so re-showing it whenever the page
 * opens something new moves it back to the front.
 *
 * A modal dialog also makes everything outside it inert, top layer included,
 * so while one is open the element is parked inside the topmost modal and
 * returned to <body> when it closes.
 *
 * Returns a cleanup function.
 */
export function keepOnTop(host: HTMLElement): () => void {
  if (typeof host.showPopover !== 'function') return () => {};

  host.popover = 'manual';
  /** Modal dialogs in the order they opened; last is topmost. */
  const modals: HTMLDialogElement[] = [
    ...document.querySelectorAll<HTMLDialogElement>('dialog:modal'),
  ];

  const openModal = (): HTMLElement | null => {
    for (let i = modals.length - 1; i >= 0; i--) {
      const dialog = modals[i]!;
      if (dialog.isConnected && dialog.matches(':modal')) return dialog;
      modals.splice(i, 1);
    }
    return null;
  };

  const raise = () => {
    const parent = openModal() ?? document.body;
    if (!parent) return;
    try {
      if (host.parentElement !== parent) {
        parent.append(host);
      } else if (host.matches(':popover-open')) {
        host.hidePopover();
      }
      host.showPopover();
    } catch {
      // Unsupported or mid-teardown; the z-index fallback still applies.
    }
  };

  let frame = 0;
  const scheduleRaise = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      raise();
    });
  };

  // Popovers (and dialogs in newer browsers) fire non-bubbling `toggle`;
  // a capturing listener on document still sees it.
  const onToggle = (event: Event) => {
    if (event.target === host) return;
    if ((event as Event & { newState?: string }).newState === 'open') {
      scheduleRaise();
    }
  };

  const observer = new MutationObserver((records) => {
    let changed = false;
    for (const record of records) {
      const target = record.target;
      if (record.type === 'attributes' && target instanceof HTMLDialogElement) {
        // showModal() / show() / close() toggle the `open` attribute.
        if (target.open && target.matches(':modal')) {
          const index = modals.indexOf(target);
          if (index !== -1) modals.splice(index, 1);
          modals.push(target);
        }
        changed = true;
      } else if (record.type === 'childList' && !host.isConnected) {
        // The page removed a dialog we were parked in.
        changed = true;
      }
    }
    if (changed) scheduleRaise();
  });

  document.addEventListener('toggle', onToggle, true);
  document.addEventListener('fullscreenchange', scheduleRaise);
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
    childList: true,
  });
  raise();

  return () => {
    document.removeEventListener('toggle', onToggle, true);
    document.removeEventListener('fullscreenchange', scheduleRaise);
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
