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
  saveTabChalkDrawing,
  setTabMoneySession,
} from './briefState';
import { drawLessonScenes } from './chalk/draw';
import { LessonError, lessonToScript, planLesson } from './chalk/lesson';
import type { ChalkLesson, SessionFormat } from './chalk/types';
import {
  addMoneyLine,
  finishMoneySession,
  startMoneySession,
  usageToLineItem,
} from './money';
import {
  clearManagedTabSession,
  openManagedSession,
  reportManagedLifecycle,
  setManagedTabSession,
} from './managed';
import { getSettings } from './storage';
import type {
  BriefProgress,
  BriefResult,
  ExtractedArticle,
  ExtensionMessage,
  ManagedLifecycleEvent,
  NewsReportScript,
  OutputLanguage,
} from './types';
import { activeModels } from './models';
import { UnderstandError, understandArticle } from './understand';

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
 *
 * A chalkboard session plans a lesson instead of a news report, then keeps
 * drawing its scenes in parallel with narration; `drawing` settles when every
 * scene has been drawn, failed, or been aborted through `signal`.
 */
export async function runBriefPipeline(
  tabId: number,
  pageUrl: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
  format: SessionFormat = 'brief',
): Promise<{ result: BriefResult; drawing: Promise<void> | null }> {
  const chalkboard = format === 'chalkboard';
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
      await setManagedTabSession(tabId, funded.sessionId);
    } catch (error) {
      await finishMoneySession(sessionId, 'fault', 'none');
      throw error;
    }
  }
  if (!auth) {
    await finishMoneySession(sessionId, 'fault', 'none');
    throw new Error('Could not authorize this brief');
  }

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
    if (managedSessionId) {
      const event: ManagedLifecycleEvent = isAbortError(error)
        ? { type: 'aborted', playbackSeconds: 0 }
        : {
            type: 'fault',
            stage: 'extract',
            playbackSeconds: 0,
          };
      await safeReportManaged(managedSessionId, event);
      await clearManagedTabSession(tabId, managedSessionId);
    }
    await finishMoneySession(
      sessionId,
      isAbortError(error) ? 'aborted' : 'fault',
      isAbortError(error) ? 'none' : 'extract',
    );
    throw error;
  }

  onProgress(
    chalkboard
      ? {
          phase: 'understanding',
          message: 'Understanding the lesson',
          detail: 'Working out what the tutorial teaches…',
        }
      : {
          phase: 'understanding',
          message: 'Understanding the story',
          detail: 'Comprehending facts, context, and stakes…',
        },
  );
  onProgress(
    chalkboard
      ? {
          phase: 'writing',
          message: 'Planning the chalkboard',
          detail: 'Scripting the lesson board by board…',
        }
      : {
          phase: 'writing',
          message: 'Writing news report',
          detail: 'Rewriting into a broadcast-ready script…',
        },
  );

  const comprehensionModel = activeModels(settings).comprehension;
  let script: NewsReportScript;
  let lesson: ChalkLesson | undefined;
  try {
    if (chalkboard) {
      const planned = await planLesson({
        auth,
        model: comprehensionModel,
        article,
        reportLength: settings.reportLength,
        outputLanguage: settings.outputLanguage,
        signal,
      });
      lesson = planned.lesson;
      script = lessonToScript(planned.lesson);
      await addMoneyLine(
        sessionId,
        usageToLineItem('understand', comprehensionModel, planned.usage),
      );
    } else {
      const understood = await understandArticle({
        auth,
        model: comprehensionModel,
        article,
        reportLength: settings.reportLength,
        outputLanguage: settings.outputLanguage,
        signal,
      });
      script = understood.script;
      await addMoneyLine(
        sessionId,
        usageToLineItem('understand', comprehensionModel, understood.usage),
      );
    }
    await assertStillOnPage(tabId, expectedUrl, signal);
  } catch (error) {
    if (error instanceof UnderstandError || error instanceof LessonError) {
      await addMoneyLine(
        sessionId,
        usageToLineItem('understand', comprehensionModel, error.usage),
      );
    }
    if (managedSessionId) {
      const event: ManagedLifecycleEvent = isAbortError(error)
        ? { type: 'aborted', playbackSeconds: 0 }
        : {
            type: 'fault',
            stage: 'understand',
            playbackSeconds: 0,
          };
      await safeReportManaged(managedSessionId, event);
      await clearManagedTabSession(tabId, managedSessionId);
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
    format,
    ...(lesson
      ? { lesson, drawings: lesson.scenes.map(() => null) }
      : {}),
    reportLength: settings.reportLength,
    moneySessionId: sessionId,
    managedSessionId,
  };

  await saveTabBriefResult(tabId, expectedUrl, result);
  // Scene 0 is requested now so its art races the first narration bytes.
  const drawing = lesson
    ? drawLessonForTab({
        tabId,
        pageUrl: expectedUrl,
        sessionId,
        lesson,
        auth,
        model: comprehensionModel,
        outputLanguage: settings.outputLanguage,
        signal,
      })
    : null;
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

  return { result, drawing };
}

/**
 * Draw every chalkboard scene in parallel, persisting each as it lands and
 * pushing it to the overlay. Failures leave that scene on its chalk notes.
 */
async function drawLessonForTab(options: {
  tabId: number;
  pageUrl: string;
  sessionId: string;
  lesson: ChalkLesson;
  auth: LlmAuth;
  model: string;
  outputLanguage: OutputLanguage;
  signal?: AbortSignal;
}): Promise<void> {
  const { tabId, pageUrl, sessionId, model, signal } = options;
  try {
    await drawLessonScenes({
      auth: options.auth,
      model,
      lesson: options.lesson,
      outputLanguage: options.outputLanguage,
      signal,
      onUsage: (usage) =>
        addMoneyLine(sessionId, usageToLineItem('draw', model, usage)),
      onScene: async (scene, drawing) => {
        if (signal?.aborted) return;
        const saved = await saveTabChalkDrawing(
          tabId,
          pageUrl,
          sessionId,
          scene,
          drawing,
        );
        if (!saved || signal?.aborted) return;
        const message: ExtensionMessage = {
          type: 'CHALK_SCENE_READY',
          pageUrl,
          sessionId,
          scene,
          drawing,
        };
        void browser.tabs.sendMessage(tabId, message).catch(() => {});
      },
    });
  } catch (error) {
    if (!isAbortError(error)) {
      console.error('Chalkboard drawing stopped', error);
    }
  }
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
