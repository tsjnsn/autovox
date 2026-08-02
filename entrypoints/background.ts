import { ensureContentScript, resetBrief, runBriefPipeline } from '../utils/brief';
import {
  clearTabBrief,
  clearTabIfUrlChanged,
  getTabBrief,
  normalizePageUrl,
  setTabProgress,
} from '../utils/briefState';
import type { BriefProgress, ExtensionMessage } from '../utils/types';

/** Abort in-flight briefs when the tab navigates away. */
const abortByTab = new Map<number, AbortController>();

async function resolveTabId(
  preferred: number | undefined,
  senderTabId: number | undefined,
): Promise<number | undefined> {
  if (preferred != null) return preferred;
  if (senderTabId != null) return senderTabId;
  const [active] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  return active?.id;
}

async function tabPageUrl(tabId: number): Promise<string> {
  const tab = await browser.tabs.get(tabId);
  return normalizePageUrl(tab.url ?? '');
}

function notifyTab(tabId: number, message: ExtensionMessage): void {
  void browser.tabs.sendMessage(tabId, message).catch(() => {});
}

function abortTabBrief(tabId: number): void {
  const existing = abortByTab.get(tabId);
  if (existing) {
    existing.abort();
    abortByTab.delete(tabId);
  }
}

async function onTabUrlChanged(tabId: number, url: string): Promise<void> {
  abortTabBrief(tabId);
  await clearTabIfUrlChanged(tabId, url);
  notifyTab(tabId, { type: 'BRIEF_RESET' });
}

async function toggleOverlayOnTab(tabId: number): Promise<void> {
  await ensureContentScript(tabId);
  await browser.tabs.sendMessage(tabId, { type: 'TOGGLE_UI' });
}

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    void (async () => {
      const tabId = tab.id;
      if (tabId == null) return;
      try {
        // Only drop state if this tab already navigated to a different URL
        if (tab.url) {
          await clearTabIfUrlChanged(tabId, tab.url);
        }
        await toggleOverlayOnTab(tabId);
      } catch (error) {
        console.error('Failed to toggle Autovox overlay', error);
      }
    })();
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    abortTabBrief(tabId);
    void clearTabBrief(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    void onTabUrlChanged(tabId, changeInfo.url);
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as ExtensionMessage;

    if (msg.type === 'GET_BRIEF_STATE') {
      void (async () => {
        const tabId = await resolveTabId(undefined, sender.tab?.id);
        if (tabId == null) {
          sendResponse({
            progress: { phase: 'idle', message: 'Idle' } satisfies BriefProgress,
            result: null,
            running: false,
          });
          return;
        }
        const url = sender.tab?.url ?? (await tabPageUrl(tabId));
        const state = await getTabBrief(tabId, url);
        // Never hydrate a script that belongs to another URL
        const result =
          state.result &&
          sameSourceUrl(state.result.source.url, url)
            ? state.result
            : null;
        sendResponse({
          progress: result ? state.progress : { phase: 'idle', message: 'Idle' },
          result,
          running: result ? state.running : false,
        });
      })();
      return true;
    }

    if (msg.type === 'OPEN_OPTIONS') {
      void (async () => {
        try {
          await browser.runtime.openOptionsPage();
          sendResponse({ ok: true });
        } catch (error) {
          console.error('Failed to open Autovox options', error);
          sendResponse({
            ok: false,
            error:
              error instanceof Error ? error.message : 'Could not open options',
          });
        }
      })();
      return true;
    }

    if (msg.type === 'CLEAR_BRIEF') {
      void (async () => {
        const tabId = await resolveTabId(undefined, sender.tab?.id);
        if (tabId != null) {
          abortTabBrief(tabId);
          await resetBrief(tabId);
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (msg.type === 'START_BRIEF') {
      void (async () => {
        const tabId = await resolveTabId(msg.tabId, sender.tab?.id);
        if (tabId == null) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }

        const pageUrl = await tabPageUrl(tabId);
        const existing = await getTabBrief(tabId, pageUrl);
        if (existing.running) {
          sendResponse({
            ok: false,
            error: 'A briefing is already in progress on this page.',
          });
          return;
        }

        abortTabBrief(tabId);
        await clearTabBrief(tabId);
        const controller = new AbortController();
        abortByTab.set(tabId, controller);

        await setTabProgress(
          tabId,
          pageUrl,
          { phase: 'extracting', message: 'Extracting article' },
          true,
        );
        sendResponse({ ok: true });

        try {
          await runBriefPipeline(
            tabId,
            pageUrl,
            (progress) => {
              void setTabProgress(tabId, pageUrl, progress, true);
              notifyTab(tabId, { type: 'BRIEF_PROGRESS', progress });
            },
            controller.signal,
          );
          if (abortByTab.get(tabId) === controller) {
            abortByTab.delete(tabId);
          }
          await setTabProgress(
            tabId,
            pageUrl,
            {
              phase: 'generating_audio',
              message: 'Generating audio',
            },
            false,
          );
        } catch (error) {
          if (abortByTab.get(tabId) === controller) {
            abortByTab.delete(tabId);
          }
          if (isAbortError(error)) {
            await clearTabBrief(tabId);
            notifyTab(tabId, { type: 'BRIEF_RESET' });
            return;
          }
          const errorMessage =
            error instanceof Error ? error.message : 'Briefing failed';
          await setTabProgress(
            tabId,
            pageUrl,
            {
              phase: 'error',
              message: 'Error',
              detail: errorMessage,
            },
            false,
          );
          notifyTab(tabId, {
            type: 'BRIEF_ERROR',
            error: errorMessage,
          });
        }
      })();
      return true;
    }
  });
});

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function sameSourceUrl(sourceUrl: string, tabUrl: string): boolean {
  try {
    return normalizePageUrl(sourceUrl) === normalizePageUrl(tabUrl);
  } catch {
    return false;
  }
}
