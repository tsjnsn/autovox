import type { LlmAuth } from '../auth';
import { getLanguageName } from '../languages';
import { createStructuredResponse, type StreamProgress } from '../openai';
import type { ProviderUsage } from '../usage';
import type {
  ExtractedArticle,
  NewsReportScript,
  OutputLanguage,
  ReportLength,
} from '../types';
import {
  CHALK_ACCESSORIES,
  flattenBeats,
  type ChalkAccessory,
  type ChalkBeat,
  type ChalkCastMember,
  type ChalkLesson,
  type ChalkScene,
} from './types';

export class LessonError extends Error {
  readonly usage: ProviderUsage;

  constructor(message: string, usage: ProviderUsage) {
    super(message);
    this.name = 'LessonError';
    this.usage = usage;
  }
}

const MAX_SCENES = 10;
const MAX_BEATS = 6;
const MAX_HEADING = 40;
const MAX_NOTE = 48;
const MAX_NOTE_WORDS = 6;
const MAX_CAST = 4;
const MAX_CAST_NAME = 14;
const WORDS_PER_SECOND = 2.4;

const LENGTH_GUIDANCE: Record<ReportLength, string> = {
  short:
    'Length: 3–4 scenes, roughly 60–90 seconds spoken (~150–220 words of narration in total).',
  standard:
    'Length: 4–6 scenes, roughly 2–3.5 minutes spoken (~350–550 words of narration in total).',
  deep:
    'Length: 6–8 scenes, roughly 3.5–5 minutes spoken (~550–800 words of narration in total). Cover more detail, edge cases, and pitfalls.',
};

const lessonSchema = {
  name: 'chalk_lesson',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: {
        type: 'string',
        description: 'Lesson title.',
      },
      cast: {
        type: 'array',
        description: '1–3 recurring stick-figure characters reused across scenes.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Short name, at most 14 characters.' },
            accessory: { type: 'string', enum: [...CHALK_ACCESSORIES] },
            role: { type: 'string', description: 'What the character stands for.' },
          },
          required: ['name', 'accessory', 'role'],
        },
      },
      scenes: {
        type: 'array',
        description: 'Ordered boards; each is drawn over its beats, then erased.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            heading: { type: 'string', description: 'Chalk title, at most 32 characters.' },
            visual: {
              type: 'string',
              description:
                'Art direction for the whole board: stick-figure scene or metaphor, left-to-right layout, cast on stage, what each beat adds.',
            },
            beats: {
              type: 'array',
              description: '2–4 beats that progressively build one picture.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  say: {
                    type: 'string',
                    description: '1–3 spoken sentences, at most ~45 words.',
                  },
                  note: { type: 'string', description: 'Chalk note, at most 6 words.' },
                },
                required: ['say', 'note'],
              },
            },
          },
          required: ['heading', 'visual', 'beats'],
        },
      },
      estimatedSeconds: {
        type: 'integer',
        description: 'Estimated spoken duration of all narration, in seconds.',
      },
    },
    required: ['title', 'cast', 'scenes', 'estimatedSeconds'],
  },
} as const;

const SYSTEM_PROMPT = `You are a gifted teacher at a chalkboard, known for making tricky material click.

Your job is to COMPREHEND a web page, then TEACH it as a live spoken lesson. The narration plays as audio while an illustrator draws simple stick-figure chalk scenes in sync with what you say, so the board is always a backdrop to your words.

This is NOT a summary and NOT a read-aloud of the page. Teach it:
- Open with a hook and say what we'll learn.
- Build the core concepts, walk through the steps in order, flag the pitfalls, then close with a short recap.
- If the page is not a tutorial, teach the underlying ideas it relies on and what the listener should take away.
- Keep facts, names, numbers, commands, and the order of steps accurate. Do not invent facts, steps, or options the page does not support.
- Speak naturally, with contractions. The narration must make sense by ear alone, but you may refer to the board the way a teacher does ("see this arrow", "over here on the left").
- Never read long code aloud. Name the key command, function, or setting and explain what it does; the board can show at most about 4 short lines of code.
- No markdown, brackets, stage directions, or "in this summary".

STRUCTURE
- The lesson is a sequence of scenes. Each scene is one full board: written, drawn over its beats, then erased before the next scene.
- heading: chalk title for the board, at most 32 characters.
- visual: concrete art direction for the whole board, for an illustrator who draws only stick figures, simple shapes, arrows, short labels, and tiny code snippets. Describe the stick-figure scene or visual metaphor, the left-to-right layout, which cast members appear and what they are doing, and what gets added on each beat.
- beats: 2–4 per scene. "say" is 1–3 spoken sentences, at most about 45 words, read verbatim by the voice. "note" is a chalk note of at most 6 words shown for that beat.
- Beats within a scene progressively build ONE coherent picture; never switch to an unrelated picture mid-scene. Start a new scene when the picture needs to change.
- cast: 1–3 recurring stick-figure characters, reused across scenes so the lesson feels continuous. Each has a short name (at most 14 characters), a distinct accessory (at most one may be "none"), and the role they play in the lesson (for example "the learner", "the server", "the build tool").
- estimatedSeconds: estimated spoken duration of all "say" text.`;

function lessonLanguageGuidance(code: OutputLanguage): string {
  const name = getLanguageName(code);
  if (!name) {
    return `Teach in the same language as the source page (its dominant language if it mixes several). Do not translate into English unless the page is primarily in English.
Every string in the JSON output (title, headings, visuals, narration, notes, cast names and roles) must be in that language.`;
  }
  return `Teach in ${name}. Translate from the source while keeping facts, names, numbers, and commands exact.
Every string in the JSON output (title, headings, visuals, narration, notes, cast names and roles) must be in ${name}.`;
}

function buildUserPrompt(
  article: ExtractedArticle,
  reportLength: ReportLength,
  outputLanguage: OutputLanguage,
): string {
  const meta = [
    `Title: ${article.title}`,
    article.byline ? `Byline: ${article.byline}` : null,
    article.siteName ? `Source: ${article.siteName}` : null,
    `URL: ${article.url}`,
    LENGTH_GUIDANCE[reportLength],
    lessonLanguageGuidance(outputLanguage),
  ]
    .filter(Boolean)
    .join('\n');

  return `${meta}

PAGE TEXT:
---
${article.textContent}
---

Produce the chalkboard lesson JSON. The first beat of the first scene is the hook; the last scene is the recap. Keep every "say" speakable as-is.`;
}

export async function planLesson(options: {
  auth: LlmAuth;
  model: string;
  article: ExtractedArticle;
  reportLength: ReportLength;
  outputLanguage: OutputLanguage;
  /** Streams the response and reports the partial lesson as it arrives. */
  onProgress?: (progress: StreamProgress) => void;
  signal?: AbortSignal;
}): Promise<{ lesson: ChalkLesson; usage: ProviderUsage }> {
  const { text: content, usage } = await createStructuredResponse({
    auth: options.auth,
    model: options.model,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(
      options.article,
      options.reportLength,
      options.outputLanguage,
    ),
    reasoningEffort: 'medium',
    maxOutputTokens: 16_000,
    jsonSchema: {
      name: lessonSchema.name,
      schema: lessonSchema.schema as unknown as Record<string, unknown>,
    },
    onProgress: options.onProgress,
    signal: options.signal,
  });

  const lesson = parseLesson(content);
  if (!lesson) {
    throw new LessonError(
      'Lesson planner returned an unreadable or incomplete lesson',
      usage,
    );
  }
  return { lesson, usage };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Trimmed, whitespace-collapsed single line. */
function line(value: unknown): string {
  return text(value).replace(/\s+/g, ' ');
}

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('').trimEnd();
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function noteFromSay(say: string): string {
  return words(say)
    .slice(0, MAX_NOTE_WORDS)
    .join(' ')
    .replace(/[,;:]+$/, '');
}

function parseBeat(value: unknown): ChalkBeat | null {
  const row = asRecord(value);
  if (!row) return null;
  const say = line(row.say);
  if (!say) return null;
  const note = line(row.note) || noteFromSay(say);
  return { say, note: clip(note, MAX_NOTE) };
}

function parseScene(value: unknown): ChalkScene | null {
  const row = asRecord(value);
  if (!row) return null;
  const heading = clip(line(row.heading), MAX_HEADING);
  if (!heading || !Array.isArray(row.beats)) return null;
  const beats = row.beats
    .map(parseBeat)
    .filter((beat): beat is ChalkBeat => beat !== null)
    .slice(0, MAX_BEATS);
  if (beats.length === 0) return null;
  return { heading, visual: text(row.visual), beats };
}

function parseCastMember(value: unknown): ChalkCastMember | null {
  const row = asRecord(value);
  if (!row) return null;
  const name = clip(line(row.name), MAX_CAST_NAME);
  if (!name) return null;
  const accessory = CHALK_ACCESSORIES.includes(row.accessory as ChalkAccessory)
    ? (row.accessory as ChalkAccessory)
    : 'none';
  return { name, accessory, role: text(row.role) };
}

/** Pure: parse + validate + normalize model JSON. Returns null when unusable. */
export function parseLesson(content: string): ChalkLesson | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  const root = asRecord(raw);
  if (!root) return null;

  const title = line(root.title);
  if (!title || !Array.isArray(root.scenes)) return null;

  const scenes = root.scenes
    .map(parseScene)
    .filter((scene): scene is ChalkScene => scene !== null)
    .slice(0, MAX_SCENES);
  if (scenes.length === 0) return null;

  const cast = Array.isArray(root.cast)
    ? root.cast
        .map(parseCastMember)
        .filter((member): member is ChalkCastMember => member !== null)
        .slice(0, MAX_CAST)
    : [];

  const stated =
    typeof root.estimatedSeconds === 'number' &&
    Number.isFinite(root.estimatedSeconds)
      ? Math.round(root.estimatedSeconds)
      : 0;
  const totalWords = scenes.reduce(
    (sum, scene) =>
      sum + scene.beats.reduce((acc, beat) => acc + words(beat.say).length, 0),
    0,
  );

  return {
    title,
    cast,
    scenes,
    estimatedSeconds:
      stated > 0 ? stated : Math.round(totalWords / WORDS_PER_SECOND),
  };
}

/** Derived script so the existing player/script-preview plumbing works. */
export function lessonToScript(lesson: ChalkLesson): NewsReportScript {
  const says = flattenBeats(lesson).map((beat) => beat.say);
  return {
    headline: lesson.title,
    lede: says[0] ?? '',
    segments: says.slice(1),
    estimatedSeconds: lesson.estimatedSeconds,
  };
}
