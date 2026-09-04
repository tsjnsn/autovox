import {
  hasLlmAuth,
  resolveLlmAuth,
  type LlmAuth,
} from './auth';
import {
  clearTabBrief,
  normalizePageUrl,
  samePageUrl,
  saveTabBriefResult,
  setTabMoneySession,
} from './briefState';
import {
  addMoneyLine,
  finishMoneySession,
  startMoneySession,
  usageToLineItem,
} from './money';
import {
  openManagedSession,
  reportManagedLifecycle,
} from './managed';
import { getSettings } from './storage';
import type {
  BriefProgress,
  BriefResult,
  ExtractedArticle,
  ExtensionMessage,
  ManagedLifecycleEvent,
  NewsReportScript,
} from './types';
import {
  COMPREHENSION_MODEL,
  UnderstandError,
  understandArticle,
} from './understand';

type ProgressFn = (progress: BriefProgress) => void;

async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const response = (await browser.tabs.sendMessage(tabId, {
      type: 'PING',
    })) as { ok?: boolean } | undefined;
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

export async function ensureContentScript(tabId: number): Promise<void> {
  if (await pingContentScript(tabId)) return;

  await browser.scripting.executeScript({
    target: { tabId },
    files: ['/content-scripts/content.js'],
  });

  for (let attempt = 0; attempt < 8; attempt++) {
    if (await pingContentScript(tabId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }

  throw new Error('Content script failed to load on this page.');
}

async function extractFromTab(tabId: number): Promise<ExtractedArticle> {
  await ensureContentScript(tabId);
  const response = (await browser.tabs.sendMessage(tabId, {
    type: 'EXTRACT_ARTICLE',
  })) as { ok: true; article: ExtractedArticle } | { ok: false; error: string };

  if (!response?.ok) {
    throw new Error(
      response && 'error' in response
        ? response.error
        : 'Could not extract article from this page',
    );
  }
  return response.article;
}

async function assertStillOnPage(
  tabId: number,
  expectedUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('Briefing aborted', 'AbortError');
  }
  const tab = await browser.tabs.get(tabId);
  const current = tab.url ?? '';
  if (!samePageUrl(current, expectedUrl)) {
    throw new DOMException('Page changed during briefing', 'AbortError');
  }
}

/**
 * Extract + understand only. TTS streams from the page overlay so playback
 * can start as soon as the script exists.
 */
export async function runBriefPipeline(
  tabId: number,
  pageUrl: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<BriefResult> {
  const expectedUrl = normalizePageUrl(pageUrl);
  const settings = await getSettings();
  if (!hasLlmAuth(settings)) {
    throw new Error(
      'Connect with OpenRouter or add an OpenAI API key in Options before briefing a page.',
    );
  }
  const managed = settings.providerMode === 'managed';
  let auth: LlmAuth | null = managed ? null : resolveLlmAuth(settings);
  let managedSessionId: string | undefined;
  const sessionId = await startMoneySession({
    kind: 'brief',
    reportLength: settings.reportLength,
    voice: settings.voice,
    outputLanguage: settings.outputLanguage,
    authMode: managed ? 'managed' : auth!.mode,
  });
  await setTabMoneySession(tabId, expectedUrl, sessionId);

  onProgress({
    phase: 'extracting',
    message: 'Extracting article',
    detail: 'Pulling the main content from the page…',
  });

  let article: ExtractedArticle;
  try {
    await assertStillOnPage(tabId, expectedUrl, signal);
    article = await extractFromTab(tabId);
    await assertStillOnPage(tabId, expectedUrl, signal);
    if (article.url && !samePageUrl(article.url, expectedUrl)) {
      throw new DOMException('Page changed during briefing', 'AbortError');
    }
  } catch (error) {
    await finishMoneySession(
      sessionId,
      isAbortError(error) ? 'aborted' : 'fault',
      isAbortError(error) ? 'none' : 'extract',
    );
    throw error;
  }

  onProgress({
    phase: 'understanding',
    message: 'Understanding the story',
    detail: 'Comprehending facts, context, and stakes…',
  });
  onProgress({
    phase: 'writing',
    message: 'Writing news report',
    detail: 'Rewriting into a broadcast-ready script…',
  });

  if (managed) {
    try {
      const funded = await openManagedSession({
        kind: 'brief',
        reportLength: settings.reportLength,
        voice: settings.voice,
        outputLanguage: settings.outputLanguage,
      });
      auth = funded.auth;
      managedSessionId = funded.sessionId;
    } catch (error) {
      await finishMoneySession(sessionId, 'fault', 'understand');
      throw error;
    }
  }
  if (!auth) {
    await finishMoneySession(sessionId, 'fault', 'understand');
    throw new Error('Could not authorize this brief');
  }

  let script: NewsReportScript;
  try {
    const understood = await understandArticle({
      auth,
      article,
      reportLength: settings.reportLength,
      outputLanguage: settings.outputLanguage,
    });
    script = understood.script;
    await addMoneyLine(
      sessionId,
      usageToLineItem('understand', COMPREHENSION_MODEL, understood.usage),
    );
    await assertStillOnPage(tabId, expectedUrl, signal);
  } catch (error) {
    if (error instanceof UnderstandError) {
      await addMoneyLine(
        sessionId,
        usageToLineItem('understand', COMPREHENSION_MODEL, error.usage),
      );
    }
    if (managedSessionId) {
      await safeReportManaged(managedSessionId, {
        type: isAbortError(error) ? 'aborted' : 'fault',
        ...(isAbortError(error)
          ? { playbackSeconds: 0 }
          : {
              stage: 'understand' as const,
              playbackSeconds: 0,
            }),
      });
    }
    await finishMoneySession(
      sessionId,
      isAbortError(error) ? 'aborted' : 'fault',
      isAbortError(error) ? 'none' : 'understand',
    );
    throw error;
  }

  const result: BriefResult = {
    source: {
      title: article.title,
      url: expectedUrl,
      siteName: article.siteName,
    },
    script,
    moneySessionId: sessionId,
    managedSessionId,
  };

  await saveTabBriefResult(tabId, expectedUrl, result);
  if (managedSessionId) {
    await safeReportManaged(managedSessionId, {
      type: 'script_ready',
      estimatedSeconds: script.estimatedSeconds,
    });
  }

  onProgress({
    phase: 'generating_audio',
    message: 'Generating audio',
    detail: 'Streaming narration…',
  });

  const ready: ExtensionMessage = { type: 'BRIEF_SCRIPT_READY', result };
  void browser.tabs.sendMessage(tabId, ready).catch(() => {});

  return result;
}

async function safeReportManaged(
  sessionId: string,
  event: ManagedLifecycleEvent,
): Promise<void> {
  try {
    await reportManagedLifecycle(sessionId, event);
  } catch {
    // The capped key expires automatically; lifecycle reporting is best-effort.
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export async function resetBrief(tabId: number): Promise<void> {
  await clearTabBrief(tabId);
}
