import './style.css';
import './chalkboard.css';
import ReactDOM from 'react-dom/client';
import { OverlayApp } from '../../components/OverlayApp';
import { extractArticleFromDocument } from '../../utils/extract';
import { enableShadowCopy } from '../../utils/shadowCopy';
import { keepOnTop } from '../../utils/topLayer';
import type { ExtensionMessage } from '../../utils/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  cssInjectionMode: 'ui',

  async main(ctx) {
    let mounted = false;
    let ui: Awaited<ReturnType<typeof createShadowRootUi>> | null = null;

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
        onMount: (container, shadow, shadowHost) => {
          const host = document.createElement('div');
          host.className = 'autovox-host';
          host.setAttribute('data-autovox', 'host');
          container.append(host);

          const app = document.createElement('div');
          host.append(app);

          const root = ReactDOM.createRoot(app);
          root.render(<OverlayApp onClose={removeUi} />);
          return {
            root,
            releaseTop: keepOnTop(shadowHost),
            releaseCopy: enableShadowCopy(shadow),
          };
        },
        onRemove: (mounted) => {
          mounted?.releaseCopy();
          mounted?.releaseTop();
          mounted?.root.unmount();
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

    // SPA soft navigations keep this content script alive; drop the old player.
    ctx.addEventListener(window, 'wxt:locationchange', removeUi);

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

      if (msg.type === 'OPEN_UI') {
        void mountUi()
          .then(() => sendResponse({ ok: true, open: true }))
          .catch((error: unknown) => {
            sendResponse({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to open overlay',
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
