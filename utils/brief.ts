import { hasLlmAuth, resolveLlmAuth } from './auth';
import {
  clearBriefResult,
  getSettings,
  saveBriefResult,
} from './storage';
import type {
  BriefProgress,
  BriefResult,
  ExtractedArticle,
  ExtensionMessage,
} from './types';
import { understandArticle } from './understand';

type ProgressFn = (progress: BriefProgress) => void;

function broadcast(progress: BriefProgress): void {
  const message: ExtensionMessage = { type: 'BRIEF_PROGRESS', progress };
  void browser.runtime.sendMessage(message).catch(() => {
    /* side panel may be closed */
  });
}

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

/**
 * Extract + understand only. TTS streams from the page overlay so playback
 * can start as soon as the script exists.
 */
export async function runBriefPipeline(
  tabId: number,
  onProgress: ProgressFn = broadcast,
): Promise<BriefResult> {
  const settings = await getSettings();
  if (!hasLlmAuth(settings)) {
    throw new Error(
      'Connect with OpenRouter or add an OpenAI API key in Options before briefing a page.',
    );
  }
  const auth = resolveLlmAuth(settings);

  onProgress({
    phase: 'extracting',
    message: 'Extracting article',
    detail: 'Pulling the main content from the page…',
  });

  const article = await extractFromTab(tabId);

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

  const script = await understandArticle({
    auth,
    article,
    reportLength: settings.reportLength,
  });

  const result: BriefResult = {
    source: {
      title: article.title,
      url: article.url,
      siteName: article.siteName,
    },
    script,
  };

  await saveBriefResult(result);

  onProgress({
    phase: 'generating_audio',
    message: 'Generating audio',
    detail: 'Streaming narration…',
  });

  const ready: ExtensionMessage = { type: 'BRIEF_SCRIPT_READY', result };
  void browser.tabs.sendMessage(tabId, ready).catch(() => {});
  void browser.runtime.sendMessage(ready).catch(() => {});

  return result;
}

export async function resetBrief(): Promise<void> {
  await clearBriefResult();
  broadcast({ phase: 'idle', message: 'Idle' });
}
