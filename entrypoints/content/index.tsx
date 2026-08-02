import './style.css';
import ReactDOM from 'react-dom/client';
import { OverlayApp } from '../../components/OverlayApp';
import { extractArticleFromDocument } from '../../utils/extract';
import type { ExtensionMessage } from '../../utils/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  cssInjectionMode: 'ui',

  async main(ctx) {
    let mounted = false;
    let ui: Awaited<ReturnType<typeof createShadowRootUi>> | null = null;
    let lastUrl = location.href;

    const removeUi = () => {
      ui?.remove();
      ui = null;
      mounted = false;
    };

    const mountUi = async () => {
      if (mounted && ui) return;

      ui = await createShadowRootUi(ctx, {
        name: 'autovox-overlay',
        position: 'inline',
        anchor: 'body',
        append: 'last',
        isolateEvents: true,
        onMount: (container) => {
          const host = document.createElement('div');
          host.className = 'autovox-host';
          host.setAttribute('data-autovox', 'host');
          container.append(host);

          const app = document.createElement('div');
          host.append(app);

          const root = ReactDOM.createRoot(app);
          root.render(<OverlayApp onClose={removeUi} />);
          return root;
        },
        onRemove: (root) => {
          root?.unmount();
        },
      });

      ui.mount();
      mounted = true;
    };

    const toggleUi = async () => {
      if (mounted) {
        removeUi();
        return { open: false };
      }
      await mountUi();
      return { open: true };
    };

    /** SPA soft navigations keep this content script alive — drop the old player. */
    const onUrlMaybeChanged = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      removeUi();
    };

    const wrapHistory = <T extends (...args: never[]) => unknown>(fn: T): T =>
      ((...args: never[]) => {
        const result = fn.apply(history, args);
        queueMicrotask(onUrlMaybeChanged);
        return result;
      }) as T;

    history.pushState = wrapHistory(history.pushState.bind(history));
    history.replaceState = wrapHistory(history.replaceState.bind(history));
    window.addEventListener('popstate', onUrlMaybeChanged);
    window.addEventListener('hashchange', onUrlMaybeChanged);
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return;
      }

      const msg = message as ExtensionMessage;

      if (msg.type === 'PING') {
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'TOGGLE_UI') {
        void toggleUi()
          .then((state) => sendResponse({ ok: true, ...state }))
          .catch((error: unknown) => {
            sendResponse({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to toggle overlay',
            });
          });
        return true;
      }

      if (msg.type === 'CLOSE_UI') {
        removeUi();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'BRIEF_RESET') {
        removeUi();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'EXTRACT_ARTICLE') {
        try {
          const article = extractArticleFromDocument();
          if (!article) {
            sendResponse({
              ok: false,
              error:
                'Not enough readable text on this page. Try a full article URL.',
            });
            return;
          }
          sendResponse({ ok: true, article });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to extract article',
          });
        }
      }
    });
  },
});
