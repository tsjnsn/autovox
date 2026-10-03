import type { LlmAuth } from './auth';
import {
  articleHintLine,
  articleHints,
  articleTypeGuidance,
  readArticleTypeField,
  resolveArticleType,
  withArticleTypeField,
  type ArticleTypeChoice,
  type ResolvedArticleType,
} from './comprehension';
import { comprehensionLanguageGuidance, type OutputLanguage } from './languages';
import { createStructuredResponse, type StreamProgress } from './openai';
import type { ProviderUsage } from './usage';
import type { ExtractedArticle, NewsReportScript, ReportLength } from './types';

export class UnderstandError extends Error {
  readonly usage: ProviderUsage;

  constructor(message: string, usage: ProviderUsage) {
    super(message);
    this.name = 'UnderstandError';
    this.usage = usage;
  }
}


const LENGTH_GUIDANCE: Record<ReportLength, string> = {
  short: 'Target roughly 60–90 seconds spoken (~150–220 words).',
  standard: 'Target roughly 2–3.5 minutes spoken (~350–550 words).',
  deep: 'Target roughly 3.5–5 minutes spoken (~550–800 words). Cover more secondary details and implications.',
};

const newsReportSchema = {
  name: 'news_report',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      headline: {
        type: 'string',
        description: 'Short broadcast-style headline for the segment.',
      },
      lede: {
        type: 'string',
        description:
          'Opening sentence that hooks the listener: the core news, scene, question, finding, or claim.',
      },
      segments: {
        type: 'array',
        description:
          'Ordered spoken paragraphs of the report body and close. Each segment should be 1–3 sentences.',
        items: { type: 'string' },
      },
      estimatedSeconds: {
        type: 'integer',
        description: 'Estimated spoken duration in seconds.',
      },
    },
    required: ['headline', 'lede', 'segments', 'estimatedSeconds'],
  },
} as const;

const SYSTEM_PROMPT = `You are an experienced broadcast writer and editor.

Your job is to COMPREHEND a web page/article, then rewrite it as a spoken report for radio/TV-style delivery, shaped by the kind of article it is.

This is NOT a high-level summary (no bullet TL;DR, no "in short").
This is NOT text-to-speech of the original page (do not read the article aloud nearly verbatim).

You must demonstrate understanding:
- Identify what the piece is really about, who is involved, why it matters, and what changed.
- Preserve important facts, names, numbers, dates, quotes, and causal relationships.
- Reorganize for the ear, following the arc for the article type below.
- Use clear spoken prose with natural contractions. Prefer concrete details over vague abstractions.
- Do not invent facts. If the source is ambiguous, say so briefly in journalistic language.
- Do not include stage directions, brackets, markdown, or "here's a summary".
- Write only what a presenter would say on air.`;

function buildUserPrompt(
  article: ExtractedArticle,
  reportLength: ReportLength,
  outputLanguage: OutputLanguage,
  hintLine: string | null,
): string {
  const meta = [
    `Title: ${article.title}`,
    article.byline ? `Byline: ${article.byline}` : null,
    article.siteName ? `Source: ${article.siteName}` : null,
    `URL: ${article.url}`,
    hintLine,
    LENGTH_GUIDANCE[reportLength],
    comprehensionLanguageGuidance(outputLanguage),
  ]
    .filter(Boolean)
    .join('\n');

  return `${meta}

ARTICLE TEXT:
---
${article.textContent}
---

Produce the script JSON. The "lede" is the opening line. "segments" carry the rest of the arc for the article type through to a brief close. Keep every string speakable as-is.`;
}

export async function understandArticle(options: {
  auth: LlmAuth;
  model: string;
  article: ExtractedArticle;
  reportLength: ReportLength;
  outputLanguage: OutputLanguage;
  /** Omitted means Infer. */
  articleType?: ArticleTypeChoice;
  /** Streams the response and reports the partial script as it arrives. */
  onProgress?: (progress: StreamProgress) => void;
  signal?: AbortSignal;
}): Promise<{
  script: NewsReportScript;
  articleType: ResolvedArticleType;
  usage: ProviderUsage;
}> {
  const choice = options.articleType ?? 'infer';
  const hints = choice === 'infer' ? articleHints(options.article) : [];
  const { text: content, usage } = await createStructuredResponse({
    auth: options.auth,
    model: options.model,
    system: `${SYSTEM_PROMPT}\n\n${articleTypeGuidance(choice, 'brief')}`,
    user: buildUserPrompt(
      options.article,
      options.reportLength,
      options.outputLanguage,
      articleHintLine(hints),
    ),
    reasoningEffort: 'medium',
    maxOutputTokens: 16_000,
    jsonSchema: {
      name: newsReportSchema.name,
      schema: withArticleTypeField(newsReportSchema.schema, choice),
    },
    onProgress: options.onProgress,
    signal: options.signal,
  });

  let parsed: NewsReportScript;
  try {
    parsed = JSON.parse(content) as NewsReportScript;
  } catch {
    throw new UnderstandError(
      'Failed to parse news report from comprehension model',
      usage,
    );
  }

  if (
    !parsed.headline?.trim() ||
    !parsed.lede?.trim() ||
    !Array.isArray(parsed.segments) ||
    parsed.segments.length === 0
  ) {
    throw new UnderstandError(
      'Comprehension model returned an incomplete news report',
      usage,
    );
  }

  return {
    script: {
      headline: parsed.headline.trim(),
      lede: parsed.lede.trim(),
      segments: parsed.segments.map((s) => s.trim()).filter(Boolean),
      estimatedSeconds:
        typeof parsed.estimatedSeconds === 'number' && parsed.estimatedSeconds > 0
          ? Math.round(parsed.estimatedSeconds)
          : Math.round(
              (parsed.lede.split(/\s+/).length +
                parsed.segments.join(' ').split(/\s+/).length) /
                2.4,
            ),
    },
    articleType: resolveArticleType(choice, readArticleTypeField(content), hints),
    usage,
  };
}

/** Full spoken script text for display / TTS assembly */
export function scriptToSpokenText(script: NewsReportScript): string {
  return [script.lede, ...script.segments].join('\n\n');
}
