import type { LlmAuth } from './auth';
import { createStructuredResponse } from './openai';
import type { ExtractedArticle, NewsReportScript, ReportLength } from './types';

/** GPT-5.6 Luna — cost-optimized model for comprehension / rewrite */
const COMPREHENSION_MODEL = 'gpt-5.6-luna';


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
        description: 'Opening sentence that hooks the listener with the core news.',
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

const SYSTEM_PROMPT = `You are an experienced broadcast news writer and editor.

Your job is to COMPREHEND a web page/article, then rewrite it as a spoken news report for radio/TV-style delivery.

This is NOT a high-level summary (no bullet TL;DR, no "in short").
This is NOT text-to-speech of the original page (do not read the article aloud nearly verbatim).

You must demonstrate understanding:
- Identify what actually happened, who is involved, why it matters, and what changed.
- Preserve important facts, names, numbers, dates, quotes, and causal relationships.
- Reorganize for oral news: cold open → context → developments → stakes/impact → close.
- Use clear spoken prose with natural contractions. Prefer concrete details over vague abstractions.
- Do not invent facts. If the source is ambiguous, say so briefly in journalistic language.
- Do not include stage directions, brackets, markdown, or "here's a summary".
- Write only what an anchor would say on air.`;

function buildUserPrompt(
  article: ExtractedArticle,
  reportLength: ReportLength,
): string {
  const meta = [
    `Title: ${article.title}`,
    article.byline ? `Byline: ${article.byline}` : null,
    article.siteName ? `Source: ${article.siteName}` : null,
    `URL: ${article.url}`,
    LENGTH_GUIDANCE[reportLength],
  ]
    .filter(Boolean)
    .join('\n');

  return `${meta}

ARTICLE TEXT:
---
${article.textContent}
---

Produce a news-report script JSON. The "lede" is the cold open. "segments" continue the report through context, developments, stakes, and a brief close. Keep every string speakable as-is.`;
}

export async function understandArticle(options: {
  auth: LlmAuth;
  article: ExtractedArticle;
  reportLength: ReportLength;
}): Promise<NewsReportScript> {
  const content = await createStructuredResponse({
    auth: options.auth,
    model: COMPREHENSION_MODEL,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(options.article, options.reportLength),
    reasoningEffort: 'medium',
    jsonSchema: {
      name: newsReportSchema.name,
      schema: newsReportSchema.schema as unknown as Record<string, unknown>,
    },
  });


  let parsed: NewsReportScript;
  try {
    parsed = JSON.parse(content) as NewsReportScript;
  } catch {
    throw new Error('Failed to parse news report from comprehension model');
  }

  if (
    !parsed.headline?.trim() ||
    !parsed.lede?.trim() ||
    !Array.isArray(parsed.segments) ||
    parsed.segments.length === 0
  ) {
    throw new Error('Comprehension model returned an incomplete news report');
  }

  return {
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
  };
}

/** Full spoken script text for display / TTS assembly */
export function scriptToSpokenText(script: NewsReportScript): string {
  return [script.lede, ...script.segments].join('\n\n');
}
