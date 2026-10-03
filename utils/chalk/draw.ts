import type { LlmAuth } from '../auth';
import { ARTICLE_TYPE_SPECS, type ArticleType } from '../comprehension';
import { getLanguageName, type OutputLanguage } from '../languages';
import { approxTokens, createStructuredResponse, type StreamProgress } from '../openai';
import { emptyUsage, type ProviderUsage } from '../usage';
import { isRepeat, sameSpot } from './geometry';
import {
  BOARD_HEADING_BAND,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  CHALK_ACCESSORIES,
  CHALK_COLORS,
  CHALK_FACES,
  CHALK_POSES,
  type ChalkAccessory,
  type ChalkColor,
  type ChalkElement,
  type ChalkElementKind,
  type ChalkFace,
  type ChalkLesson,
  type ChalkPose,
  type ChalkScene,
  type ChalkSceneDrawing,
} from './types';

export class DrawError extends Error {
  readonly usage: ProviderUsage;

  constructor(message: string, usage: ProviderUsage) {
    super(message);
    this.name = 'DrawError';
    this.usage = usage;
  }
}

const ELEMENT_KINDS: readonly ChalkElementKind[] = [
  'figure',
  'text',
  'box',
  'circle',
  'line',
  'arrow',
  'path',
  'check',
  'cross',
  'code',
];

const MAX_ELEMENTS = 40;
/** A full board is ~1–2k tokens of JSON plus low-effort reasoning. */
const DRAW_MAX_OUTPUT_TOKENS = 8000;
/** Ceiling per attempt; slow hosts that keep streaming get this long to finish. */
const DRAW_ATTEMPT_TIMEOUT_MS = 180_000;
/** An attempt with no streamed tokens for this long has stalled. */
const DRAW_IDLE_TIMEOUT_MS = 45_000;
/** Reasoning tokens allowed before any drawing output; well above what "low" effort uses. */
const DRAW_REASONING_LIMIT = 3000;
const MAX_PATH_POINTS = 60;
const MAX_LABEL = 24;
const MAX_SAY = 40;
const BOARD_TOP = BOARD_HEADING_BAND;

const nullableNumber = { type: ['number', 'null'] } as const;

const drawingSchema = {
  name: 'chalk_scene',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: [...ELEMENT_KINDS] },
            beat: { type: 'integer' },
            color: { type: 'string', enum: [...CHALK_COLORS] },
            x: nullableNumber,
            y: nullableNumber,
            x2: nullableNumber,
            y2: nullableNumber,
            size: nullableNumber,
            curve: nullableNumber,
            text: { type: ['string', 'null'] },
            say: { type: ['string', 'null'] },
            // Anthropic rejects enums whose type is a ['string', 'null'] union.
            pose: { type: 'string', enum: [...CHALK_POSES] },
            face: { type: 'string', enum: [...CHALK_FACES] },
            accessory: { type: 'string', enum: [...CHALK_ACCESSORIES] },
            points: { type: ['array', 'null'], items: { type: 'number' } },
            closed: { type: ['boolean', 'null'] },
          },
          required: [
            'kind',
            'beat',
            'color',
            'x',
            'y',
            'x2',
            'y2',
            'size',
            'curve',
            'text',
            'say',
            'pose',
            'face',
            'accessory',
            'points',
            'closed',
          ],
        },
      },
    },
    required: ['elements'],
  },
} as const;

const DRAWING_RULES = `You draw ONE board (a scene) as a list of simple chalk elements that appear beat by beat, in sync with the narration, so the board is always a coherent backdrop to what is being said.

BOARD
- 1000 wide × 600 tall. Origin top-left, x grows right, y grows DOWN.
- y < 80 is reserved for the scene heading, which the renderer writes itself. Never draw there and never repeat the heading.
- Keep 30-unit margins from the left, right, and bottom edges: the drawing area is x 30–970, y 90–570.

COMPOSITION
- Plan ONE coherent composition for the whole scene first, following the art direction, then list the elements. Leave room for later beats.
- Stick figures are the star: typically 120–180 tall, y = their feet. Share a ground line (e.g. y ≈ 520) unless the scene calls for something else.
- Every appearance of a cast member uses their accessory, and their label (text) is their name. Other figures use accessory "none".
- Each beat adds 1–5 elements illustrating exactly what that beat says, listed in the order a teacher would draw them. 6–20 elements in total.
- Avoid overlaps: keep figures, boxes, and text clear of each other. The renderer places speech bubbles, figure names, and arrow labels in the clearest spot nearby, so leave free space around each figure (above the head, below the feet) and along arrows.

CHANGES OVER THE BEATS
- Everything drawn stays on the board until the scene ends; the board builds up.
- To show something change, redraw it in a later beat at the SAME spot: a figure with the same name at the same x and y (new pose, face, or speech bubble), or text over the same spot (an updated number or caption). The renderer erases the old one, then draws the new one in its place.
- Never redraw something that hasn't changed: it is still on the board. Never draw two different things in one spot unless the later one should replace the earlier.
- Prefer visual metaphors over words. Use text only for key terms. Labels at most 5 words, speech bubbles at most 6 words.
- White chalk by default; yellow, pink, blue, or green sparingly for emphasis.
- code only for literal short code: at most 4 lines, at most 28 characters per line.
- Arrows for flow and cause; check / cross for do / don't; path for graphs, curves, and waves.

ELEMENT FIELDS
Every element lists every field; set fields that do not apply to its kind to null, except pose, face, and accessory, which non-figure elements set to "stand", "neutral", and "none".
- kind; beat = 0-based index of the beat at which it is drawn; color.
- figure: x = body center, y = feet, size = total height (60–320), pose, face, accessory, text = name label under the figure or null, say = speech bubble or null.
- text: x, y = top-left, size = letter height (16–64, ~30), text = the words (up to 4 lines, separated by \\n).
- code: x, y = top-left, size = letter height (14–32, ~20), text = the code lines separated by \\n.
- box: (x, y) = one corner, (x2, y2) = the opposite corner, text = label centered inside or null.
- circle: x, y = center, size = radius (8–250), text = label centered inside or null.
- line: from (x, y) to (x2, y2).
- arrow: from tail (x, y) to head (x2, y2); curve = −1..1 bend of the shaft (0 straight, the sign picks the side); text = short label or null.
- path: points = flattened coordinates [x0, y0, x1, y1, …] of a polyline (2–60 points); closed = true to join the last point back to the first. Sharp turns stay sharp corners (stairs, triangles, zigzags, bar outlines) and gentle bends are smoothed, so give curves and waves many closely spaced points (about every 30 units).
- check / cross: x, y = center, size = width (~40).
- pose, face, accessory, say are only for figure; points and closed only for path; curve only for arrow.`;

/** Boards drawn before article types existed keep the explainer's teacher. */
function systemPrompt(articleType: ArticleType | undefined): string {
  const { presenter } = ARTICLE_TYPE_SPECS[articleType ?? 'explainer'];
  return `You are a chalkboard illustrator working beside ${presenter} live. ${DRAWING_RULES}`;
}

function languageGuidance(code: OutputLanguage): string {
  const name = getLanguageName(code);
  return name
    ? `Write every label, text, and speech bubble in ${name}.`
    : 'Write every label, text, and speech bubble in the same language as the narration below.';
}

function buildUserPrompt(
  lesson: ChalkLesson,
  scene: ChalkScene,
  sceneIndex: number,
  outputLanguage: OutputLanguage,
): string {
  const previous = sceneIndex > 0 ? lesson.scenes[sceneIndex - 1] : undefined;
  const cast = lesson.cast.length
    ? lesson.cast
        .map(
          (member) =>
            `- ${member.name} (accessory: ${member.accessory})${member.role ? ` — ${member.role}` : ''}`,
        )
        .join('\n')
    : '- (no recurring cast; use unnamed figures)';
  const headings = lesson.scenes
    .map(
      (s, i) =>
        `${i + 1}. ${s.heading}${i === sceneIndex ? '  ← this board' : ''}`,
    )
    .join('\n');
  const beats = scene.beats
    .map(
      (beat, i) =>
        `Beat ${i}: says "${beat.say}"\n  chalk note: "${beat.note}"`,
    )
    .join('\n');
  const lastBeat = scene.beats.length - 1;

  return `Lesson: ${lesson.title}
${languageGuidance(outputLanguage)}

CAST
${cast}

ALL BOARDS (for continuity)
${headings}

PREVIOUS BOARD
${previous ? `"${previous.heading}" — ${previous.visual || '(no art direction)'}` : '(none — this is the first board)'}

THIS BOARD (${sceneIndex + 1} of ${lesson.scenes.length}): "${scene.heading}"
Art direction: ${scene.visual || '(none given — invent a fitting stick-figure scene)'}

BEATS
${beats}

Return the elements for this board, using ${lastBeat === 0 ? 'beat 0 only' : `beat values 0–${lastBeat}`}.`;
}

/** The exact prompts and schema a scene drawing request sends. */
export function drawSceneRequest(
  lesson: ChalkLesson,
  sceneIndex: number,
  outputLanguage: OutputLanguage,
  articleType?: ArticleType,
): {
  system: string;
  user: string;
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  const scene = lesson.scenes[sceneIndex];
  if (!scene) {
    throw new RangeError(`No scene at index ${sceneIndex}`);
  }
  return {
    system: systemPrompt(articleType),
    user: buildUserPrompt(lesson, scene, sceneIndex, outputLanguage),
    jsonSchema: {
      name: drawingSchema.name,
      schema: drawingSchema.schema as unknown as Record<string, unknown>,
    },
  };
}

export async function drawScene(options: {
  auth: LlmAuth;
  model: string;
  lesson: ChalkLesson;
  sceneIndex: number;
  outputLanguage: OutputLanguage;
  /** Frames who the boards are drawn for; omitted keeps the explainer's teacher. */
  articleType?: ArticleType;
  /** Reports streamed token progress as it arrives. */
  onProgress?: (progress: StreamProgress) => void;
  signal?: AbortSignal;
}): Promise<{ drawing: ChalkSceneDrawing; usage: ProviderUsage }> {
  const scene = options.lesson.scenes[options.sceneIndex];
  if (!scene) {
    throw new RangeError(`No scene at index ${options.sceneIndex}`);
  }

  // Streaming separates a slow host that is still producing tokens (let it
  // finish) from a stalled one or a model that ignores "low" effort and
  // reasons without drawing (cut it off early).
  const guard = new AbortController();
  let stopReason = '';
  const stop = (reason: string) => {
    if (guard.signal.aborted) return;
    stopReason = reason;
    guard.abort();
  };
  let idleTimer = setTimeout(
    () => stop(`No tokens for ${DRAW_IDLE_TIMEOUT_MS / 1000}s`),
    DRAW_IDLE_TIMEOUT_MS,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, guard.signal])
    : guard.signal;
  let result: { text: string; usage: ProviderUsage };
  try {
    result = await createStructuredResponse({
      auth: options.auth,
      model: options.model,
      ...drawSceneRequest(
        options.lesson,
        options.sceneIndex,
        options.outputLanguage,
        options.articleType,
      ),
      reasoningEffort: 'low',
      maxOutputTokens: DRAW_MAX_OUTPUT_TOKENS,
      hostSort: 'throughput',
      onProgress: (progress) => {
        options.onProgress?.(progress);
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => stop(`No tokens for ${DRAW_IDLE_TIMEOUT_MS / 1000}s`),
          DRAW_IDLE_TIMEOUT_MS,
        );
        if (
          progress.outputChars === 0 &&
          approxTokens(progress.reasoningChars) > DRAW_REASONING_LIMIT
        ) {
          stop(`Reasoned past ${DRAW_REASONING_LIMIT} tokens without drawing`);
        }
      },
      signal,
    });
  } catch (error) {
    if (guard.signal.aborted && !options.signal?.aborted) {
      throw new DrawError(stopReason, emptyUsage());
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
  const { text: content, usage } = result;

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new DrawError('Failed to parse scene drawing from model', usage);
  }

  const drawing = applyCast(
    sanitizeDrawing(raw, scene.beats.length),
    options.lesson,
  );
  if (drawing.elements.length === 0) {
    throw new DrawError('Scene drawing had no usable elements', usage);
  }
  return { drawing, usage };
}

/** Cast members keep their accessory wherever the model labels them. */
function applyCast(
  drawing: ChalkSceneDrawing,
  lesson: ChalkLesson,
): ChalkSceneDrawing {
  if (lesson.cast.length === 0) return drawing;
  const byName = new Map(
    lesson.cast.map((member) => [member.name.toLowerCase(), member.accessory]),
  );
  return {
    elements: drawing.elements.map((element) => {
      if (element.kind !== 'figure' || !element.label) return element;
      const accessory = byName.get(element.label.toLowerCase());
      return accessory ? { ...element, accessory } : element;
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampX(value: number): number {
  return clamp(value, 0, BOARD_WIDTH);
}

function clampY(value: number): number {
  return clamp(value, BOARD_TOP, BOARD_HEIGHT);
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('').trimEnd();
}

/** Single-line label; empty → null. */
function label(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const single = value.replace(/\s+/g, ' ').trim();
  return single ? clip(single, max) : null;
}

/** Multi-line text; code keeps its indentation. Empty → null. */
function block(
  value: unknown,
  maxLines: number,
  maxChars: number,
  code: boolean,
): string | null {
  if (typeof value !== 'string') return null;
  let rows = value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((row) => (code ? row.trimEnd() : row.replace(/\s+/g, ' ').trim()));
  if (code) {
    while (rows.length && !rows[0]) rows.shift();
    while (rows.length && !rows[rows.length - 1]) rows.pop();
  } else {
    rows = rows.filter(Boolean);
  }
  if (rows.length === 0) return null;
  return rows
    .slice(0, maxLines)
    .map((row) => clip(row, maxChars))
    .join('\n');
}

function pathPoints(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value)) return null;
  const pairs: Array<[number, number]> = [];
  if (value.every((item) => Array.isArray(item))) {
    for (const item of value as unknown[][]) {
      const x = num(item[0]);
      const y = num(item[1]);
      if (x !== null && y !== null) pairs.push([clampX(x), clampY(y)]);
    }
  } else {
    for (let i = 0; i + 1 < value.length; i += 2) {
      const x = num(value[i]);
      const y = num(value[i + 1]);
      if (x !== null && y !== null) pairs.push([clampX(x), clampY(y)]);
    }
  }
  if (pairs.length < 2) return null;
  if (pairs.length <= MAX_PATH_POINTS) return pairs;
  const step = (pairs.length - 1) / (MAX_PATH_POINTS - 1);
  const sampled: Array<[number, number]> = [];
  for (let i = 0; i < MAX_PATH_POINTS; i++) {
    const point = pairs[Math.round(i * step)];
    if (point) sampled.push(point);
  }
  return sampled;
}

function sanitizeElement(
  raw: unknown,
  maxBeat: number,
): ChalkElement | null {
  const row = asRecord(raw);
  if (!row || !ELEMENT_KINDS.includes(row.kind as ChalkElementKind)) {
    return null;
  }
  const kind = row.kind as ChalkElementKind;
  const beatValue = num(row.beat);
  const beat = clamp(beatValue === null ? 0 : Math.round(beatValue), 0, maxBeat);
  const color = pick<ChalkColor>(row.color, CHALK_COLORS, 'white');
  const x = num(row.x);
  const y = num(row.y);
  const x2 = num(row.x2);
  const y2 = num(row.y2);
  const size = num(row.size);

  switch (kind) {
    case 'figure': {
      if (x === null || y === null) return null;
      let height = clamp(size ?? 150, 60, 320);
      let feet = clampY(y);
      if (feet - height < BOARD_TOP) {
        feet = Math.min(BOARD_HEIGHT, BOARD_TOP + height);
      }
      if (feet - height < BOARD_TOP) height = feet - BOARD_TOP;
      return {
        kind,
        beat,
        color,
        x: clampX(x),
        y: feet,
        size: height,
        pose: pick<ChalkPose>(row.pose, CHALK_POSES, 'stand'),
        face: pick<ChalkFace>(row.face, CHALK_FACES, 'neutral'),
        accessory: pick<ChalkAccessory>(
          row.accessory,
          CHALK_ACCESSORIES,
          'none',
        ),
        label: label(row.text, MAX_LABEL),
        say: label(row.say, MAX_SAY),
      };
    }
    case 'text':
    case 'code': {
      if (x === null || y === null) return null;
      const isCode = kind === 'code';
      const text = isCode
        ? block(row.text, 6, 40, true)
        : block(row.text, 4, 60, false);
      if (!text) return null;
      const fontSize = isCode
        ? clamp(size ?? 20, 14, 32)
        : clamp(size ?? 30, 16, 64);
      return {
        kind,
        beat,
        color,
        x: clampX(x),
        y: clamp(y, BOARD_TOP, BOARD_HEIGHT - fontSize),
        size: fontSize,
        text,
      };
    }
    case 'box': {
      if (x === null || y === null || x2 === null || y2 === null) return null;
      const ax = clampX(x);
      const bx = clampX(x2);
      const ay = clampY(y);
      const by = clampY(y2);
      const w = Math.max(20, Math.abs(bx - ax));
      const h = Math.max(20, Math.abs(by - ay));
      return {
        kind,
        beat,
        color,
        x: Math.min(Math.min(ax, bx), BOARD_WIDTH - w),
        y: Math.min(Math.min(ay, by), BOARD_HEIGHT - h),
        w,
        h,
        label: label(row.text, MAX_LABEL),
      };
    }
    case 'circle': {
      if (x === null || y === null) return null;
      const r = clamp(size ?? 40, 8, 250);
      return {
        kind,
        beat,
        color,
        x: clamp(x, r, BOARD_WIDTH - r),
        y: clamp(y, BOARD_TOP + r, BOARD_HEIGHT - r),
        r,
        label: label(row.text, MAX_LABEL),
      };
    }
    case 'line':
    case 'arrow': {
      if (x === null || y === null || x2 === null || y2 === null) return null;
      const from = { x: clampX(x), y: clampY(y) };
      const to = { x: clampX(x2), y: clampY(y2) };
      if (Math.hypot(to.x - from.x, to.y - from.y) < 1) return null;
      if (kind === 'line') {
        return { kind, beat, color, x: from.x, y: from.y, x2: to.x, y2: to.y };
      }
      return {
        kind,
        beat,
        color,
        x: from.x,
        y: from.y,
        x2: to.x,
        y2: to.y,
        curve: clamp(num(row.curve) ?? 0, -1, 1),
        label: label(row.text, MAX_LABEL),
      };
    }
    case 'path': {
      const points = pathPoints(row.points);
      if (!points) return null;
      return { kind, beat, color, points, closed: row.closed === true };
    }
    case 'check':
    case 'cross': {
      if (x === null || y === null) return null;
      const width = clamp(size ?? 40, 16, 160);
      const half = width / 2;
      return {
        kind,
        beat,
        color,
        x: clamp(x, half, BOARD_WIDTH - half),
        y: clamp(y, BOARD_TOP + half, BOARD_HEIGHT - half),
        size: width,
      };
    }
  }
}

/** Pure: raw model JSON (already JSON.parsed) → sanitized drawing per the contract. */
export function sanitizeDrawing(
  raw: unknown,
  beatCount: number,
): ChalkSceneDrawing {
  const list: unknown = Array.isArray(raw) ? raw : asRecord(raw)?.elements;
  if (!Array.isArray(list)) return { elements: [] };
  const maxBeat = Math.max(0, Math.floor(beatCount) - 1);
  const elements = list
    .map((item) => sanitizeElement(item, maxBeat))
    .filter((element): element is ChalkElement => element !== null)
    .map((element, order) => ({ element, order }))
    .sort((a, b) => a.element.beat - b.element.beat || a.order - b.order)
    .slice(0, MAX_ELEMENTS)
    .map(({ element }) => element);
  return { elements: dropRepeats(elements) };
}

/** Drops elements that redraw, unchanged, whatever was last drawn in their spot. */
export function dropRepeats(elements: readonly ChalkElement[]): ChalkElement[] {
  const kept: ChalkElement[] = [];
  for (const element of elements) {
    let last: ChalkElement | undefined;
    for (let i = kept.length - 1; i >= 0 && !last; i--) {
      const prior = kept[i]!;
      if (sameSpot(prior, element) || isRepeat(prior, element)) last = prior;
    }
    if (!last || !isRepeat(last, element)) kept.push(element);
  }
  return kept;
}

/** Draw every scene in parallel with bounded concurrency. */
export async function drawLessonScenes(options: {
  auth: LlmAuth;
  model: string;
  lesson: ChalkLesson;
  outputLanguage: OutputLanguage;
  articleType?: ArticleType;
  signal?: AbortSignal;
  concurrency?: number;
  onScene: (
    sceneIndex: number,
    drawing: ChalkSceneDrawing,
  ) => void | Promise<void>;
  onUsage?: (usage: ProviderUsage) => void | Promise<void>;
  /** Streams each board and reports its token progress; `attempt` counts from 1. */
  onProgress?: (sceneIndex: number, attempt: number, progress: StreamProgress) => void;
  /** Test seam; defaults to drawScene. */
  draw?: typeof drawScene;
}): Promise<{ drawn: number; failed: number }> {
  const { signal } = options;
  const draw = options.draw ?? drawScene;
  const total = options.lesson.scenes.length;
  const requested = options.concurrency ?? 3;
  const concurrency = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : 3;
  let next = 0;
  let drawn = 0;
  let failed = 0;

  const reportUsage = async (usage: ProviderUsage) => {
    try {
      await options.onUsage?.(usage);
    } catch {
      // Spend records must not break drawing.
    }
  };

  const attempt = async (
    sceneIndex: number,
  ): Promise<ChalkSceneDrawing | null> => {
    for (let tries = 0; tries < 2 && !signal?.aborted; tries++) {
      const timeout = AbortSignal.timeout(DRAW_ATTEMPT_TIMEOUT_MS);
      try {
        const result = await draw({
          auth: options.auth,
          model: options.model,
          lesson: options.lesson,
          sceneIndex,
          outputLanguage: options.outputLanguage,
          articleType: options.articleType,
          onProgress: options.onProgress
            ? (progress) => options.onProgress?.(sceneIndex, tries + 1, progress)
            : undefined,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        await reportUsage(result.usage);
        return result.drawing;
      } catch (error) {
        if (signal?.aborted) break;
        console.warn(
          `[autovox] chalk scene ${sceneIndex} draw attempt ${tries + 1} failed`,
          error,
        );
        if (error instanceof DrawError) await reportUsage(error.usage);
      }
    }
    return null;
  };

  const worker = async () => {
    while (next < total && !signal?.aborted) {
      const sceneIndex = next++;
      const drawing = await attempt(sceneIndex);
      if (signal?.aborted) return;
      if (!drawing) {
        failed++;
        continue;
      }
      drawn++;
      try {
        await options.onScene(sceneIndex, drawing);
      } catch {
        // A broken consumer must not stop the remaining scenes.
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );
  return { drawn, failed };
}
