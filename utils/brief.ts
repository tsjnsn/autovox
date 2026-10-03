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
  coerceArticleTypeChoice,
  type ArticleType,
  type ArticleTypeChoice,
  type ResolvedArticleType,
} from './comprehension';
import {
  addMoneyLine,
  finishMoneySession,
  setMoneyArticleType,
  startMoneySession,
  usageToLineItem,
} from './money';
import {
  clearManagedTabSession,
  openManagedSession,
  reportManagedLifecycle,
  setManagedTabSession,
} from './managed';
import {
  BRIEF_DRAFT_KEYS,
  countWords,
  DRAFT_TARGET_WORDS,
  draftText,
  LESSON_DRAFT_KEYS,
} from './draft';
import { PageError, SetupError } from './errors';
import { languageFromDetection, type OutputLanguage } from './languages';
import type { StreamProgress } from './openai';
import { getSettings } from './storage';
import type {
  BriefDraft,
  BriefProgress,
  BriefResult,
  ExtractedArticle,
  ExtensionMessage,
  ManagedLifecycleEvent,
  NewsReportScript,
} from './types';
import { activeModels } from './models';
import { UnderstandError, understandArticle } from './understand';

type ProgressFn = (progress: BriefProgress) => void;

/** Live drafts are throttled to keep tab messaging light. */
const DRAFT_INTERVAL_MS = 120;

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

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/content.js'],
    });
  } catch (error) {
    throw new PageError(
      error instanceof Error
        ? error.message
        : 'Content script failed to load on this page.',
    );
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    if (await pingContentScript(tabId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }

  throw new PageError('Content script failed to load on this page.');
}

async function extractFromTab(tabId: number): Promise<ExtractedArticle> {
  await ensureContentScript(tabId);
  const response = (await browser.tabs.sendMessage(tabId, {
    type: 'EXTRACT_ARTICLE',
  })) as { ok: true; article: ExtractedArticle } | { ok: false; error: string };

  if (!response?.ok) {
    throw new PageError(
      response && 'error' in response
        ? response.error
        : 'Could not extract article from this page',
    );
  }
  return response.article;
}

/**
 * "Auto" becomes the page's detected language, so the writer, the drawer, and
 * the narrator are all told the same language instead of each guessing.
 * Stays "auto" (models infer it) when Chrome's detector is unsure.
 */
async function resolveOutputLanguage(
  choice: OutputLanguage,
  article: ExtractedArticle,
): Promise<OutputLanguage> {
  if (choice !== 'auto') return choice;
  try {
    const detected = await browser.i18n.detectLanguage(
      `${article.title}\n${article.textContent}`.slice(0, 20_000),
    );
    return languageFromDetection(detected) ?? 'auto';
  } catch {
    return 'auto';
  }
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
  onDraft?: (draft: BriefDraft) => void,
  /** The overlay's pick for this page; omitted uses the Options default. */
  articleTypeChoice?: ArticleTypeChoice,
): Promise<{ result: BriefResult; drawing: Promise<void> | null }> {
  const chalkboard = format === 'chalkboard';
  const expectedUrl = normalizePageUrl(pageUrl);
  const settings = await getSettings();
  if (!hasLlmAuth(settings)) {
    throw new SetupError(
      'Connect with OpenRouter or add an OpenAI API key in Options before briefing a page.',
    );
  }
  const managed = settings.providerMode === 'managed';
  let auth: LlmAuth | null = managed ? null : resolveLlmAuth(settings);
  let managedSessionId: string | undefined;
  const kind = chalkboard ? 'chalkboard' : 'brief';
  const sessionId = await startMoneySession({
    kind,
    reportLength: settings.reportLength,
    voice: settings.voice,
    outputLanguage: settings.outputLanguage,
    authMode: managed ? 'managed' : auth!.mode,
  });
  await setTabMoneySession(tabId, expectedUrl, sessionId);

  if (managed) {
    try {
      const funded = await openManagedSession({
        kind,
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

  const outputLanguage = await resolveOutputLanguage(settings.outputLanguage, article);

  const sourceWords = countWords(article.textContent);
  onProgress(
    chalkboard
      ? {
          phase: 'understanding',
          message: 'Understanding the page',
          detail: 'Working out what to put on the boards…',
          sourceWords,
        }
      : {
          phase: 'understanding',
          message: 'Understanding the story',
          detail: 'Comprehending facts, context, and stakes…',
          sourceWords,
        },
  );

  // Writing starts when the first spoken words stream in, not when the request does.
  const draftKeys = chalkboard ? LESSON_DRAFT_KEYS : BRIEF_DRAFT_KEYS;
  const targetWords = DRAFT_TARGET_WORDS[settings.reportLength];
  let writing = false;
  let lastDraftAt = 0;
  const onStream = (progress: StreamProgress) => {
    const now = Date.now();
    if (!progress.text || now - lastDraftAt < DRAFT_INTERVAL_MS) return;
    const text = draftText(progress.text, draftKeys);
    if (!text) return;
    lastDraftAt = now;
    if (!writing) {
      writing = true;
      onProgress(
        chalkboard
          ? {
              phase: 'writing',
              message: 'Planning the chalkboard',
              detail: 'Scripting it board by board…',
              sourceWords,
            }
          : {
              phase: 'writing',
              message: 'Writing news report',
              detail: 'Rewriting into a broadcast-ready script…',
              sourceWords,
            },
      );
    }
    onDraft?.({ text, words: countWords(text), targetWords });
  };

  const { comprehension: comprehensionModel, drawing: drawingModel } =
    activeModels(settings);
  const typeChoice = coerceArticleTypeChoice(
    articleTypeChoice ?? settings.articleType,
  );
  let script: NewsReportScript;
  let lesson: ChalkLesson | undefined;
  let articleType: ResolvedArticleType;
  try {
    if (chalkboard) {
      const planned = await planLesson({
        auth,
        model: comprehensionModel,
        article,
        reportLength: settings.reportLength,
        outputLanguage,
        articleType: typeChoice,
        onProgress: onDraft ? onStream : undefined,
        signal,
      });
      lesson = planned.lesson;
      articleType = planned.articleType;
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
        outputLanguage,
        articleType: typeChoice,
        onProgress: onDraft ? onStream : undefined,
        signal,
      });
      script = understood.script;
      articleType = understood.articleType;
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
  await setMoneyArticleType(sessionId, articleType);

  const result: BriefResult = {
    source: {
      title: article.title,
      url: expectedUrl,
      siteName: article.siteName,
    },
    script,
    format,
    articleType,
    ...(lesson
      ? { lesson, drawings: lesson.scenes.map(() => null) }
      : {}),
    reportLength: settings.reportLength,
    outputLanguage,
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
        model: drawingModel,
        outputLanguage,
        articleType: articleType.type,
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
  articleType: ArticleType;
  signal?: AbortSignal;
}): Promise<void> {
  const { tabId, pageUrl, sessionId, model, signal } = options;
  try {
    await drawLessonScenes({
      auth: options.auth,
      model,
      lesson: options.lesson,
      outputLanguage: options.outputLanguage,
      articleType: options.articleType,
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
