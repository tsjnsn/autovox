import { ensureContentScript, resetBrief, runBriefPipeline } from '../utils/brief';
import { getBriefResult } from '../utils/storage';
import type { BriefProgress, ExtensionMessage } from '../utils/types';

let running = false;
let latestProgress: BriefProgress = { phase: 'idle', message: 'Idle' };

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
        await toggleOverlayOnTab(tabId);
      } catch (error) {
        console.error('Failed to toggle Autovox overlay', error);
      }
    })();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message as ExtensionMessage;

    if (msg.type === 'BRIEF_PROGRESS') {
      latestProgress = msg.progress;
      return;
    }

    if (msg.type === 'BRIEF_SCRIPT_READY') {
      latestProgress = {
        phase: 'generating_audio',
        message: 'Generating audio',
        detail: msg.result.script.headline,
      };
      return;
    }

    if (msg.type === 'GET_BRIEF_STATE') {
      void (async () => {
        const result = await getBriefResult();
        sendResponse({
          progress: latestProgress,
          result,
          running,
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
        await resetBrief();
        latestProgress = { phase: 'idle', message: 'Idle' };
        running = false;
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (msg.type === 'START_BRIEF') {
      void (async () => {
        if (running) {
          sendResponse({ ok: false, error: 'A briefing is already in progress.' });
          return;
        }

        const tabId =
          msg.tabId ??
          sender.tab?.id ??
          (
            await browser.tabs.query({
              active: true,
              currentWindow: true,
            })
          )[0]?.id;

        if (tabId == null) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }

        running = true;
        latestProgress = {
          phase: 'extracting',
          message: 'Extracting article',
        };
        sendResponse({ ok: true });

        try {
          await runBriefPipeline(tabId, (progress) => {
            latestProgress = progress;
            const update: ExtensionMessage = {
              type: 'BRIEF_PROGRESS',
              progress,
            };
            void browser.tabs.sendMessage(tabId, update).catch(() => {});
            void browser.runtime.sendMessage(update).catch(() => {});
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Briefing failed';
          latestProgress = {
            phase: 'error',
            message: 'Error',
            detail: errorMessage,
          };
          const errMsg: ExtensionMessage = {
            type: 'BRIEF_ERROR',
            error: errorMessage,
          };
          void browser.tabs.sendMessage(tabId, errMsg).catch(() => {});
          void browser.runtime.sendMessage(errMsg).catch(() => {});
        } finally {
          running = false;
        }
      })();
      return true;
    }
  });
});
