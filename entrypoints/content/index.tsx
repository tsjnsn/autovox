import './style.css';
import './chalkboard.css';
import ReactDOM from 'react-dom/client';
import { OverlayApp } from '../../components/OverlayApp';
import { watchCommittedUrl } from '../../utils/committedUrl';
import { extractArticleFromDocument } from '../../utils/extract';
import { enableShadowCopy } from '../../utils/shadowCopy';
import { keepOnTop } from '../../utils/topLayer';
import type { ExtensionMessage } from '../../utils/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  cssInjectionMode: 'ui',

  async main(ctx) {
    let ui: Awaited<ReturnType<typeof createShadowRootUi>> | null = null;
    /** Set while the overlay is open or opening; settles once it is listening. */
    let ready: Promise<void> | null = null;
    let abandonReady: ((reason: Error) => void) | null = null;

    const removeUi = () => {
      abandonReady?.(new Error('Overlay closed before it was ready'));
      abandonReady = null;
      ready = null;
      ui?.remove();
      ui = null;
    };

    const openUi = async (onReady: () => void, isCurrent: () => boolean) => {
      const created = await createShadowRootUi(ctx, {
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
          root.render(<OverlayApp onClose={removeUi} onReady={onReady} />);
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

      if (!isCurrent()) return;
      created.mount();
      ui = created;
    };

    const mountUi = (): Promise<void> => {
      if (ready) return ready;
      const opening: Promise<void> = new Promise<void>((resolve, reject) => {
        abandonReady = reject;
        void openUi(resolve, () => ready === opening).catch(
          (error: unknown) => {
            if (ready === opening) {
              ready = null;
              abandonReady = null;
            }
            reject(error);
          },
        );
      });
      ready = opening;
      return opening;
    };

    const toggleUi = async () => {
      if (ready) {
        removeUi();
        return { open: false };
      }
      await mountUi();
      return { open: true };
    };

    // SPA soft navigations keep this content script alive; drop the old player.
    const navigation = (globalThis as { navigation?: EventTarget }).navigation;
    if (navigation) {
      watchCommittedUrl(navigation, () => location.href, removeUi, ctx.signal);
    } else {
      // Without the Navigation API, WXT polls location.href, which only changes on commit.
      ctx.addEventListener(window, 'wxt:locationchange', removeUi);
    }

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
