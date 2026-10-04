import { ensureContentScript, resetBrief, runBriefPipeline } from '../utils/brief';
import {
  clearTabBrief,
  clearTabIfUrlChanged,
  getTabBrief,
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
import type { SessionFormat } from '../utils/chalk/types';
import { managedError } from '../convex/lib/errors';
import type { ArticleTypeChoice } from '../utils/comprehension';
import {
  briefErrorKind,
  errorMessage,
  errorResponse,
  type ErrorResponse,
} from '../utils/errors';
import { followUpOpenUrl, isFollowUpTarget } from '../utils/followUp';
import { artifactHistory } from '../utils/history';
import { finishMoneySession } from '../utils/money';
import {
  attachNarrationUsage,
  ensureManagedNarrationSession,
  isNarrationCached,
  runNarration,
  streamNarrationSegment,
  type ManagedNarrationRequest,
  type ManagedNarrationSession,
} from '../utils/narration';
import { narrationCache } from '../utils/narrationCache';
import { NARRATION_PORT, serveNarrationPort } from '../utils/narrationProtocol';
import {
  credentialsKey,
  overlaySettings,
  overlaySettingsView,
} from '../utils/overlaySettings';
import { normalizePageUrl } from '../utils/pageUrl';
import { coerceSettings, getSettings, SETTINGS_KEY } from '../utils/storage';
import type {
  BriefProgress,
  BriefResult,
  ExtensionMessage,
  Settings,
} from '../utils/types';

const CONTEXT_MENU_VOX_PAGE = 'autovox-vox-page';
const CONTEXT_MENU_CHALKBOARD = 'autovox-chalkboard-page';

/**
 * Abort in-flight briefs when the tab navigates away. A chalkboard keeps its
 * controller registered until every scene has drawn, so navigation, Clear,
 * or a new brief also stops scene drawing.
 */
const abortByTab = new Map<number, AbortController>();
type ManagedAcquisition = {
  cancelled: boolean;
  promise: Promise<ManagedNarrationSession>;
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
  void clearActionFault(tabId);
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

/**
 * The tab's managed session for narration, opening a paid replay when the
 * brief's session has ended; with `cached`, a fully saved narration needs none.
 */
async function acquireManagedSessionForTab(
  tabId: number,
  request: ManagedNarrationRequest,
  cached: boolean,
): Promise<ManagedNarrationSession> {
  const existing = managedAcquisitionByTab.get(tabId);
  if (existing) return await existing.promise;

  let acquisition!: ManagedAcquisition;
  const promise = (async (): Promise<ManagedNarrationSession> => {
    const session = await ensureManagedNarrationSession(request, cached, {
      sessionAuth: getManagedSessionAuth,
      report: reportManagedLifecycle,
      openReplay: (dims) => openManagedSession({ kind: 'tts_replay', ...dims }),
    });
    if (acquisition.cancelled) {
      if (session.sessionId) {
        await reportManagedLifecycle(session.sessionId, {
          type: 'aborted',
          playbackSeconds: 0,
        });
      }
      throw new Error('Managed narration was cancelled');
    }
    if (session.sessionId) await setManagedTabSession(tabId, session.sessionId);
    return session;
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

function assertManagedConfigured(): void {
  if (!isManagedConfigured()) {
    throw managedError(
      'not_configured',
      'Managed listening is not configured in this build',
    );
  }
}

/** The brief the overlay on this page was given. */
async function savedTabBrief(
  tabId: number,
  url: string,
): Promise<BriefResult | null> {
  const state = await getTabBrief(tabId, url);
  return state.result && sameSourceUrl(state.result.source.url, url)
    ? state.result
    : null;
}

/** For narration that was prepared as cached but whose saved audio is gone. */
async function acquireManagedForNarration(
  tabId: number,
  brief: BriefResult,
  settings: Settings,
): Promise<{ sessionId: string; auth: LlmAuth }> {
  assertManagedConfigured();
  const sessionId =
    (await getManagedTabSession(tabId)) ?? brief.managedSessionId;
  if (!sessionId) throw new Error('Managed listening is unavailable');
  const request: ManagedNarrationRequest = {
    sessionId,
    estimatedSeconds: brief.script.estimatedSeconds,
    reportLength: brief.reportLength ?? settings.reportLength,
    voice: settings.voice,
    outputLanguage: settings.outputLanguage,
  };
  // A cached preparation still in flight resolves without a session.
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await acquireManagedSessionForTab(tabId, request, false);
    if (session.sessionId !== null) return session;
  }
  throw new Error('Could not authorize managed narration');
}

async function broadcastToTabs(message: ExtensionMessage): Promise<void> {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id != null) notifyTab(tab.id, message);
  }
}

let localStorageRestricted: Promise<void> = Promise.resolve();

/**
 * Keys and the spend ledger live in `storage.local`, which content scripts,
 * running in the page's process, can read by default. Chrome versions that
 * can't restrict it reject the call.
 */
async function restrictLocalStorage(): Promise<void> {
  try {
    await browser.storage.local.setAccessLevel({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
  } catch (error) {
    console.warn('[autovox] could not restrict local storage to the extension', error);
  }
}

async function sendOverlayMessage(
  tabId: number,
  type: 'TOGGLE_UI' | 'OPEN_UI',
): Promise<void> {
  await localStorageRestricted;
  await ensureContentScript(tabId);
  const response = (await browser.tabs.sendMessage(tabId, { type })) as
    | { ok: true }
    | ErrorResponse
    | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? 'Overlay did not open');
  }
}

async function toggleOverlayOnTab(tabId: number): Promise<void> {
  await sendOverlayMessage(tabId, 'TOGGLE_UI');
}

/** Resolves once the overlay is listening for BRIEF_* messages. */
async function openOverlayOnTab(tabId: number): Promise<void> {
  await sendOverlayMessage(tabId, 'OPEN_UI');
}

/** With no overlay to carry the Fault label, the toolbar icon carries it for this tab. */
async function showActionFault(tabId: number): Promise<void> {
  try {
    await browser.action.setBadgeBackgroundColor({ tabId, color: '#E23B2F' });
    await browser.action.setBadgeText({ tabId, text: '!' });
    await browser.action.setTitle({ tabId, title: 'Autovox: Fault' });
  } catch {
    // The tab closed.
  }
}

async function clearActionFault(tabId: number): Promise<void> {
  try {
    await browser.action.setBadgeText({ tabId, text: '' });
    await browser.action.setTitle({
      tabId,
      title: browser.runtime.getManifest().action?.default_title ?? 'Autovox',
    });
  } catch {
    // The tab closed.
  }
}

/**
 * Start a brief for a tab.
 * @param force When true (toolbar/play), replace any existing result. When false
 *   (context menu), skip if already running or a matching brief exists.
 */
async function startBriefForTab(
  tabId: number,
  options: {
    force?: boolean;
    format?: SessionFormat;
    articleType?: ArticleTypeChoice;
  } = {},
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const force = options.force ?? false;
  const format = options.format ?? 'brief';
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
    sameSourceUrl(existing.result.source.url, pageUrl) &&
    (existing.result.format ?? 'brief') === format
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
    const { drawing } = await runBriefPipeline(
      tabId,
      pageUrl,
      (progress) => {
        void setTabProgress(tabId, pageUrl, progress, true);
        notifyTab(tabId, { type: 'BRIEF_PROGRESS', progress });
      },
      controller.signal,
      format,
      (draft) => notifyTab(tabId, { type: 'BRIEF_DRAFT', pageUrl, draft }),
      options.articleType,
    );
    const release = () => {
      if (abortByTab.get(tabId) === controller) {
        abortByTab.delete(tabId);
      }
    };
    if (drawing) {
      void drawing.finally(release);
    } else {
      release();
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
    const errorText = errorMessage(error, 'Briefing failed');
    await setTabProgress(
      tabId,
      pageUrl,
      {
        phase: 'error',
        message: 'Error',
        detail: errorText,
      },
      false,
    );
    notifyTab(tabId, {
      type: 'BRIEF_ERROR',
      error: errorText,
      kind: briefErrorKind(error),
    });
    return { ok: false, error: errorText };
  }
}

function registerContextMenus(): void {
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: CONTEXT_MENU_VOX_PAGE,
      title: 'Vox this page',
      contexts: ['page'],
    });
    browser.contextMenus.create({
      id: CONTEXT_MENU_CHALKBOARD,
      title: 'Chalkboard this page',
      contexts: ['page'],
    });
  });
}

export default defineBackground(() => {
  localStorageRestricted = restrictLocalStorage();
  void narrationCache()
    .evict()
    .catch((error: unknown) =>
      console.warn('[autovox] could not sweep saved narration', error),
    );

  browser.runtime.onInstalled.addListener(() => {
    registerContextMenus();
  });
  // Saved briefs don't survive a browser restart, so neither can their audio be replayed.
  browser.runtime.onStartup.addListener(() => {
    void narrationCache()
      .clear()
      .catch((error: unknown) =>
        console.warn('[autovox] could not clear saved narration', error),
      );
  });
  // Ensure menu exists after SW restart without reinstall
  registerContextMenus();

  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[SETTINGS_KEY];
    if (area !== 'local' || !change) return;
    const before = coerceSettings(change.oldValue);
    const after = coerceSettings(change.newValue);
    void broadcastToTabs({
      type: 'OVERLAY_SETTINGS_CHANGED',
      settings: overlaySettings(after),
      credentialsChanged: credentialsKey(before) !== credentialsKey(after),
    });
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== NARRATION_PORT) return;
    const tabId = port.sender?.tab?.id;
    const pageUrl = port.sender?.tab?.url ?? port.sender?.url;
    if (tabId == null || !pageUrl) {
      port.disconnect();
      return;
    }
    serveNarrationPort(port, (request, signal, emit) =>
      runNarration(request, signal, emit, {
        loadBrief: () => savedTabBrief(tabId, pageUrl),
        loadSettings: getSettings,
        cache: narrationCache(),
        managedAuth: getManagedSessionAuth,
        acquireManaged: (brief, settings) =>
          acquireManagedForNarration(tabId, brief, settings),
        openSegment: streamNarrationSegment,
        attachUsage: attachNarrationUsage,
        onCacheError: (error) =>
          console.warn('[autovox] could not save narration audio', error),
      }),
    );
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const format: SessionFormat | null =
      info.menuItemId === CONTEXT_MENU_VOX_PAGE
        ? 'brief'
        : info.menuItemId === CONTEXT_MENU_CHALKBOARD
          ? 'chalkboard'
          : null;
    if (!format) return;
    const tabId = tab?.id;
    if (tabId == null) return;
    const pageUrl = tab?.url;

    void (async () => {
      await clearActionFault(tabId);
      try {
        if (pageUrl) {
          await clearTabIfUrlChanged(tabId, pageUrl);
        }
        await openOverlayOnTab(tabId);
        await startBriefForTab(tabId, { force: false, format });
      } catch (error) {
        console.error('Failed to vox page from context menu', error);
        await showActionFault(tabId);
      }
    })();
  });

  browser.action.onClicked.addListener((tab) => {
    void (async () => {
      const tabId = tab.id;
      if (tabId == null) return;
      await clearActionFault(tabId);
      try {
        if (tab.url) {
          await clearTabIfUrlChanged(tabId, tab.url);
        }
        await toggleOverlayOnTab(tabId);
      } catch (error) {
        console.error('Failed to toggle Autovox overlay', error);
        await showActionFault(tabId);
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
          sendResponse(errorResponse(error, 'Could not open options'));
        }
      })();
      return true;
    }

    if (msg.type === 'LIST_ARTIFACTS') {
      void (async () => {
        try {
          const artifacts = await artifactHistory().list();
          sendResponse({
            ok: true,
            artifacts: artifacts.map((artifact) => ({
              id: artifact.id,
              createdAt: artifact.createdAt,
              format: artifact.format,
              headline: artifact.headline,
              sourceTitle: artifact.sourceTitle,
              siteName: artifact.siteName,
            })),
          });
        } catch (error) {
          sendResponse(errorResponse(error, 'Could not read saved briefs'));
        }
      })();
      return true;
    }

    if (msg.type === 'GET_ARTIFACT') {
      void (async () => {
        try {
          if (typeof msg.id !== 'string' || msg.id.length === 0) {
            throw new Error('Unknown brief');
          }
          const artifact = await artifactHistory().get(msg.id);
          sendResponse(artifact ? { ok: true, artifact } : { ok: false });
        } catch (error) {
          sendResponse(errorResponse(error, 'Could not open that brief'));
        }
      })();
      return true;
    }

    if (msg.type === 'REMOVE_ARTIFACT') {
      void (async () => {
        try {
          if (typeof msg.id !== 'string' || msg.id.length === 0) {
            throw new Error('Unknown brief');
          }
          await artifactHistory().remove(msg.id);
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse(errorResponse(error, 'Could not remove that brief'));
        }
      })();
      return true;
    }

    if (msg.type === 'OPEN_FOLLOW_UP') {
      void (async () => {
        try {
          if (!isFollowUpTarget(msg.target)) {
            throw new Error('Unknown follow-up target');
          }
          await browser.tabs.create({ url: followUpOpenUrl(msg.target) });
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse(errorResponse(error, 'Could not open the chat'));
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
          sendResponse(errorResponse(error, 'Could not load managed credits'));
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
          sendResponse(
            errorResponse(error, 'Could not initialize managed listening'),
          );
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
          sendResponse(errorResponse(error, 'Could not start checkout'));
        }
      })();
      return true;
    }

    if (msg.type === 'GET_OVERLAY_SETTINGS') {
      void (async () => {
        try {
          sendResponse(overlaySettingsView(await getSettings()));
        } catch (error) {
          console.warn('[autovox] could not load overlay settings', error);
          sendResponse(overlaySettingsView(undefined));
        }
      })();
      return true;
    }

    if (msg.type === 'PREPARE_MANAGED_NARRATION') {
      void (async () => {
        try {
          assertManagedConfigured();
          const tabId = sender.tab?.id;
          if (tabId == null) {
            throw new Error('Managed narration requires a browser tab');
          }
          const url = sender.tab?.url ?? (await tabPageUrl(tabId));
          const brief = await savedTabBrief(tabId, url);
          const cached = brief
            ? await isNarrationCached(brief, await getSettings(), narrationCache())
            : false;
          const session = await acquireManagedSessionForTab(
            tabId,
            {
              sessionId: msg.sessionId,
              estimatedSeconds: msg.estimatedSeconds,
              reportLength: msg.reportLength,
              voice: msg.voice,
              outputLanguage: msg.outputLanguage,
            },
            cached,
          );
          sendResponse({ ok: true, sessionId: session.sessionId });
        } catch (error) {
          sendResponse(
            errorResponse(error, 'Could not authorize managed narration'),
          );
        }
      })();
      return true;
    }

    if (msg.type === 'FINISH_NARRATION_SPEND') {
      void (async () => {
        const outcomes = ['completed', 'fault', 'aborted'] as const;
        if (
          typeof msg.sessionId === 'string' &&
          outcomes.includes(msg.outcome) &&
          (msg.faultStage === 'tts' || msg.faultStage === 'none')
        ) {
          await finishMoneySession(msg.sessionId, msg.outcome, msg.faultStage);
        }
        sendResponse({ ok: true });
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
          sendResponse(
            errorResponse(error, 'Could not report managed listening'),
          );
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
          sendResponse({
            ok: false,
            error: 'No active tab found.',
            kind: 'fault',
          } satisfies ErrorResponse);
          return;
        }

        const pageUrl = await tabPageUrl(tabId);
        const existing = await getTabBrief(tabId, pageUrl);
        if (existing.running) {
          sendResponse({
            ok: false,
            error: 'A briefing is already in progress on this page.',
            kind: 'transient',
          } satisfies ErrorResponse);
          return;
        }

        sendResponse({ ok: true });
        const outcome = await startBriefForTab(tabId, {
          force: true,
          format: msg.format,
          articleType: msg.articleType,
        });
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
