import { ensureContentScript, resetBrief, runBriefPipeline } from '../utils/brief';
import {
  clearTabBrief,
  clearTabIfUrlChanged,
  getTabBrief,
  normalizePageUrl,
  setTabProgress,
} from '../utils/briefState';
import {
  createManagedCheckout,
  clearManagedTabSession,
  ensureManagedAccount,
  getManagedAccountStatus,
  getManagedSessionAuth,
  getManagedTabSession,
  isManagedConfigured,
  openManagedSession,
  reportManagedLifecycle,
  setManagedTabSession,
} from '../utils/managed';
import type { LlmAuth } from '../utils/auth';
import type { BriefProgress, ExtensionMessage } from '../utils/types';

const CONTEXT_MENU_VOX_PAGE = 'autovox-vox-page';

/** Abort in-flight briefs when the tab navigates away. */
const abortByTab = new Map<number, AbortController>();
type ManagedAuthRequest = Extract<
  ExtensionMessage,
  { type: 'GET_MANAGED_AUTH' }
>;
type ManagedAuthResult = { sessionId: string; auth: LlmAuth };
type ManagedAcquisition = {
  cancelled: boolean;
  promise: Promise<ManagedAuthResult>;
};
const managedAcquisitionByTab = new Map<number, ManagedAcquisition>();

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
  await abortManagedSessionForTab(tabId);
  await clearTabIfUrlChanged(tabId, url);
  notifyTab(tabId, { type: 'BRIEF_RESET' });
}

async function abortManagedSessionForTab(tabId: number): Promise<void> {
  const acquisition = managedAcquisitionByTab.get(tabId);
  if (acquisition) acquisition.cancelled = true;
  const state = await getTabBrief(tabId);
  const sessionId =
    (await getManagedTabSession(tabId)) ??
    state.result?.managedSessionId;
  if (!sessionId) return;
  try {
    await reportManagedLifecycle(sessionId, {
      type: 'aborted',
      playbackSeconds: 0,
    });
  } catch {
    // The session key is capped and expires automatically.
  } finally {
    await clearManagedTabSession(tabId, sessionId);
  }
}

async function acquireManagedAuthForTab(
  tabId: number,
  request: ManagedAuthRequest,
): Promise<ManagedAuthResult> {
  const existing = managedAcquisitionByTab.get(tabId);
  if (existing) return await existing.promise;

  let acquisition!: ManagedAcquisition;
  const promise = (async (): Promise<ManagedAuthResult> => {
    let sessionId = request.sessionId;
    let auth = await getManagedSessionAuth(sessionId);
    if (!auth) {
      try {
        await reportManagedLifecycle(sessionId, {
          type: 'aborted',
          playbackSeconds: 0,
        });
      } catch {
        // A completed or expired session may already be terminal.
      }
      let replay: Awaited<ReturnType<typeof openManagedSession>> | null =
        null;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          replay = await openManagedSession({
            kind: 'tts_replay',
            reportLength: request.reportLength,
            voice: request.voice,
            outputLanguage: request.outputLanguage,
          });
          break;
        } catch (error) {
          lastError = error;
          if (
            !(error instanceof Error) ||
            !error.message.includes('already in progress') ||
            attempt === 2
          ) {
            throw error;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1)),
          );
        }
      }
      if (!replay) throw lastError;
      sessionId = replay.sessionId;
      auth = replay.auth;
      await reportManagedLifecycle(sessionId, {
        type: 'script_ready',
        estimatedSeconds: request.estimatedSeconds,
      });
    }
    if (acquisition.cancelled) {
      await reportManagedLifecycle(sessionId, {
        type: 'aborted',
        playbackSeconds: 0,
      });
      throw new Error('Managed narration was cancelled');
    }
    await setManagedTabSession(tabId, sessionId);
    return { sessionId, auth };
  })();
  acquisition = { cancelled: false, promise };
  managedAcquisitionByTab.set(tabId, acquisition);
  try {
    return await promise;
  } finally {
    if (managedAcquisitionByTab.get(tabId) === acquisition) {
      managedAcquisitionByTab.delete(tabId);
    }
  }
}

async function toggleOverlayOnTab(tabId: number): Promise<void> {
  await ensureContentScript(tabId);
  await browser.tabs.sendMessage(tabId, { type: 'TOGGLE_UI' });
}

async function openOverlayOnTab(tabId: number): Promise<void> {
  await ensureContentScript(tabId);
  await browser.tabs.sendMessage(tabId, { type: 'OPEN_UI' });
}

/**
 * Start a brief for a tab.
 * @param force When true (toolbar/play), replace any existing result. When false
 *   (context menu), skip if already running or a matching brief exists.
 */
async function startBriefForTab(
  tabId: number,
  options: { force?: boolean } = {},
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const force = options.force ?? false;
  const pageUrl = await tabPageUrl(tabId);
  const existing = await getTabBrief(tabId, pageUrl);

  if (existing.running) {
    return force
      ? { ok: false, error: 'A briefing is already in progress on this page.' }
      : { ok: true, skipped: true };
  }

  if (
    !force &&
    existing.result &&
    sameSourceUrl(existing.result.source.url, pageUrl)
  ) {
    return { ok: true, skipped: true };
  }

  abortTabBrief(tabId);
  await abortManagedSessionForTab(tabId);
  await clearTabBrief(tabId);
  const controller = new AbortController();
  abortByTab.set(tabId, controller);

  await setTabProgress(
    tabId,
    pageUrl,
    { phase: 'extracting', message: 'Extracting article' },
    true,
  );

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
    return { ok: true };
  } catch (error) {
    if (abortByTab.get(tabId) === controller) {
      abortByTab.delete(tabId);
    }
    if (isAbortError(error)) {
      await clearTabBrief(tabId);
      notifyTab(tabId, { type: 'BRIEF_RESET' });
      return { ok: false, error: 'Briefing aborted' };
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
    return { ok: false, error: errorMessage };
  }
}

function registerContextMenus(): void {
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: CONTEXT_MENU_VOX_PAGE,
      title: 'Vox this page',
      contexts: ['page'],
    });
  });
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    registerContextMenus();
  });
  // Ensure menu exists after SW restart without reinstall
  registerContextMenus();

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_VOX_PAGE) return;
    const tabId = tab?.id;
    if (tabId == null) return;
    const pageUrl = tab?.url;

    void (async () => {
      try {
        if (pageUrl) {
          await clearTabIfUrlChanged(tabId, pageUrl);
        }
        await openOverlayOnTab(tabId);
        // Let OverlayApp mount and attach BRIEF_* listeners
        await new Promise((resolve) => setTimeout(resolve, 80));
        await startBriefForTab(tabId, { force: false });
      } catch (error) {
        console.error('Failed to vox page from context menu', error);
      }
    })();
  });

  browser.action.onClicked.addListener((tab) => {
    void (async () => {
      const tabId = tab.id;
      if (tabId == null) return;
      try {
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
    void (async () => {
      await abortManagedSessionForTab(tabId);
      await clearTabBrief(tabId);
    })();
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
        const result =
          state.result && sameSourceUrl(state.result.source.url, url)
            ? state.result
            : null;
        sendResponse({
          progress: result
            ? state.progress
            : state.running
              ? state.progress
              : { phase: 'idle', message: 'Idle' },
          result,
          running: state.running,
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

    if (msg.type === 'GET_MANAGED_ACCOUNT') {
      void (async () => {
        try {
          const status = await getManagedAccountStatus();
          sendResponse({ ok: true, status });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Could not load managed credits',
          });
        }
      })();
      return true;
    }

    if (msg.type === 'ENSURE_MANAGED_ACCOUNT') {
      void (async () => {
        try {
          const status = await ensureManagedAccount();
          sendResponse({ ok: true, status });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Could not initialize managed listening',
          });
        }
      })();
      return true;
    }

    if (msg.type === 'START_MANAGED_CHECKOUT') {
      void (async () => {
        try {
          const url = await createManagedCheckout();
          await browser.tabs.create({ url });
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Could not start checkout',
          });
        }
      })();
      return true;
    }

    if (msg.type === 'GET_MANAGED_AUTH') {
      void (async () => {
        try {
          if (!isManagedConfigured()) {
            throw new Error('Managed listening is not configured');
          }
          if (sender.tab?.id == null) {
            throw new Error('Managed narration requires a browser tab');
          }
          const managed = await acquireManagedAuthForTab(
            sender.tab.id,
            msg,
          );
          sendResponse({ ok: true, ...managed });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Could not authorize managed narration',
          });
        }
      })();
      return true;
    }

    if (msg.type === 'MANAGED_LIFECYCLE') {
      void (async () => {
        try {
          await reportManagedLifecycle(msg.sessionId, msg.event);
          if (
            sender.tab?.id != null &&
            (msg.event.type === 'completed' ||
              msg.event.type === 'fault' ||
              msg.event.type === 'aborted')
          ) {
            await clearManagedTabSession(
              sender.tab.id,
              msg.sessionId,
            );
          }
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Could not report managed listening',
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
          await abortManagedSessionForTab(tabId);
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

        sendResponse({ ok: true });
        const outcome = await startBriefForTab(tabId, { force: true });
        if (!outcome.ok && outcome.error && outcome.error !== 'Briefing aborted') {
          // Error already notified to the tab via BRIEF_ERROR
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
