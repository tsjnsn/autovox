import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  authApiRoot,
  authRequestHeaders,
  openRouterProviderPrefs,
  type LlmAuth,
} from '../../utils/auth';
import type { ChalkLesson } from '../../utils/chalk/types';
import type { ExtractedArticle } from '../../utils/types';
import { fillUsageCost, parseProviderUsage, type ProviderUsage } from '../../utils/usage';
import { drawingRubricType, drawRubric, writeRubric, writingRubricType } from './rubric';
import {
  addUsage,
  DRAW_CRITERIA,
  emptySpend,
  errorMessage,
  WRITE_CRITERIA,
  type EvalResults,
  type JudgeCall,
  type JudgedEntry,
  type Judging,
} from './shared';

const run = promisify(execFile);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] &&
    join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findChrome(): string {
  const found = CHROME_CANDIDATES.find((path) => path && existsSync(path));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH to render boards for the judge.');
  return found;
}

export const boardKey = (runIndex: number, scene: number) => `${runIndex}:${scene}`;

/** Matches the export block the viewer writes in `?export=1` mode. */
const EXPORT_BLOCK = /<script type="application\/json" id="chalk-export">([\s\S]*?)<\/script>/;

/**
 * Paint every drawn board at 1000×600 with the viewer's export mode in one
 * headless Chrome run, save them under boards/, and return PNG data URLs.
 */
export async function exportBoardImages(outDir: string): Promise<Map<string, string>> {
  const page = `${pathToFileURL(resolve(outDir, 'index.html')).href}?export=1`;
  // A throwaway profile keeps headless Chrome away from the user's own browser.
  const profile = mkdtempSync(join(tmpdir(), 'chalk-eval-chrome-'));
  let dom: string;
  try {
    const { stdout } = await run(
      findChrome(),
      [
        '--headless=new',
        '--disable-gpu',
        '--force-device-scale-factor=1',
        '--virtual-time-budget=5000',
        `--user-data-dir=${profile}`,
        '--dump-dom',
        page,
      ],
      { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 },
    );
    dom = stdout;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const block = EXPORT_BLOCK.exec(dom)?.[1];
  if (!block) throw new Error('Viewer export produced no board images');
  const images = JSON.parse(block) as Record<string, string>;

  const boardsDir = resolve(outDir, 'boards');
  mkdirSync(boardsDir, { recursive: true });
  const boards = new Map<string, string>();
  for (const [key, dataUrl] of Object.entries(images)) {
    boards.set(key, dataUrl);
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    writeFileSync(resolve(boardsDir, `${key.replace(':', '-')}.png`), base64, 'base64');
  }
  return boards;
}

const JUDGE_TIMEOUT_MS = 5 * 60_000;

type Part =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

async function judgeRequest(options: {
  auth: LlmAuth;
  model: string;
  system: string;
  content: Part[];
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<{ data: unknown; usage: ProviderUsage }> {
  const response = await fetch(`${authApiRoot(options.auth)}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    headers: { ...authRequestHeaders(options.auth), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      max_tokens: 12_000,
      reasoning: { effort: 'medium' },
      response_format: {
        type: 'json_schema',
        json_schema: { name: options.schemaName, strict: true, schema: options.schema },
      },
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.content },
      ],
      ...openRouterProviderPrefs(options.auth),
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  const usage = await fillUsageCost(options.auth, parseProviderUsage(body));
  if (!response.ok) {
    throw Object.assign(
      new Error(`Judge request failed (${response.status}): ${JSON.stringify(body).slice(0, 400)}`),
      { usage },
    );
  }
  const choices = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw Object.assign(new Error('Judge returned no content'), { usage });
  }
  const json = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return { data: JSON.parse(json) as unknown, usage };
}

const labelFor = (i: number) => String.fromCharCode(65 + i);

function scoredListSchema(
  listKey: string,
  criteria: readonly string[],
  labels: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      [listKey]: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', enum: labels },
            ...Object.fromEntries(criteria.map((c) => [c, { type: 'integer' }])),
            note: { type: 'string' },
          },
          required: ['label', ...criteria, 'note'],
        },
      },
      ranking: { type: 'array', items: { type: 'string', enum: labels } },
    },
    required: [listKey, 'ranking'],
  };
}

/** Pure: judge JSON → entries keyed by run index, scores clamped to 1–10. */
export function parseJudgeOutput<C extends string>(
  data: unknown,
  listKey: string,
  criteria: readonly C[],
  order: readonly number[],
): JudgedEntry<C>[] {
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const list = Array.isArray(root[listKey]) ? (root[listKey] as unknown[]) : [];
  const ranking = Array.isArray(root.ranking)
    ? (root.ranking as unknown[]).filter((l): l is string => typeof l === 'string')
    : [];
  const labelToRun = new Map(order.map((runIndex, i) => [labelFor(i), runIndex]));
  const rankOf = (label: string) => {
    const position = [...new Set(ranking)].indexOf(label);
    return position >= 0 ? position + 1 : order.length;
  };
  const entries: JudgedEntry<C>[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const label = typeof row.label === 'string' ? row.label : '';
    const runIndex = labelToRun.get(label);
    if (runIndex === undefined || seen.has(runIndex)) continue;
    seen.add(runIndex);
    const scores = Object.fromEntries(
      criteria.map((c) => {
        const value = typeof row[c] === 'number' ? (row[c] as number) : 1;
        return [c, Math.min(10, Math.max(1, Math.round(value)))];
      }),
    ) as Record<C, number>;
    entries.push({
      run: runIndex,
      scores,
      rank: rankOf(label),
      note: typeof row.note === 'string' ? row.note.slice(0, 400) : '',
    });
  }
  return entries;
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function lessonText(lesson: ChalkLesson): string {
  const cast = lesson.cast.map((c) => `${c.name} (${c.accessory}): ${c.role}`).join('; ');
  const scenes = lesson.scenes
    .map((scene, i) => {
      const beats = scene.beats
        .map((beat, b) => `    ${b + 1}. "${beat.say}"  [note: ${beat.note}]`)
        .join('\n');
      return `  Board ${i + 1}: ${scene.heading}\n    Art direction: ${scene.visual}\n${beats}`;
    })
    .join('\n');
  return `Title: ${lesson.title}\nCast: ${cast || '(none)'}\n${scenes}`;
}

export async function judgeEval(options: {
  auth: LlmAuth;
  model: string;
  passes: number;
  results: EvalResults;
  article: ExtractedArticle | null;
  boards: Map<string, string>;
  log: (line: string) => void;
}): Promise<Judging> {
  const { auth, model, results, boards, log } = options;
  const judging: Judging = {
    model,
    passes: options.passes,
    spend: emptySpend(),
    writing: [],
    drawing: [],
  };
  const writingType = writingRubricType(results);
  const drawingType = drawingRubricType(results);
  log(
    `judge  rubric: plans as ${writingType ?? 'explainer (untyped run)'}, boards as ${drawingType ?? 'explainer (untyped run)'}`,
  );

  const writers = results.writing
    .map((w, index) => ({ w, index }))
    .filter(({ w }) => w.ok && w.lesson);
  for (let pass = 1; pass <= options.passes; pass++) {
    if (writers.length < 2 || !options.article) break;
    const order = shuffled(writers.map(({ index }) => index));
    const labels = order.map((_, i) => labelFor(i));
    const plans = order
      .map((runIndex, i) => `=== Plan ${labels[i]} ===\n${lessonText(results.writing[runIndex]!.lesson!)}`)
      .join('\n\n');
    const call: JudgeCall<(typeof WRITE_CRITERIA)[number]> = { pass, order, entries: [] };
    try {
      const { data, usage } = await judgeRequest({
        auth,
        model,
        system: writeRubric(writingType),
        schemaName: 'plan_scores',
        schema: scoredListSchema('plans', WRITE_CRITERIA, labels),
        content: [
          {
            type: 'text',
            text: `SOURCE ARTICLE: ${options.article.title}\n---\n${options.article.textContent}\n---\n\n${plans}\n\nScore and rank plans ${labels.join(', ')}.`,
          },
        ],
      });
      addUsage(judging.spend, usage);
      call.entries = parseJudgeOutput(data, 'plans', WRITE_CRITERIA, order);
      log(`judge  writing (pass ${pass}) ✓`);
    } catch (error) {
      const usage = (error as { usage?: ProviderUsage }).usage;
      if (usage) addUsage(judging.spend, usage);
      call.error = errorMessage(error);
      log(`judge  writing (pass ${pass}) FAILED ${call.error}`);
    }
    judging.writing.push(call);
  }

  const lesson = results.reference?.lesson;
  if (lesson) {
    for (let pass = 1; pass <= options.passes; pass++) {
      for (let scene = 0; scene < lesson.scenes.length; scene++) {
        const available = results.drawing
          .map((_, runIndex) => runIndex)
          .filter((runIndex) => boards.has(boardKey(runIndex, scene)));
        if (available.length === 0) continue;
        const order = shuffled(available);
        const labels = order.map((_, i) => labelFor(i));
        const s = lesson.scenes[scene]!;
        const context = `Lesson: ${lesson.title}
Board ${scene + 1} of ${lesson.scenes.length}: "${s.heading}"
Art direction: ${s.visual}
Narration, in order:
${s.beats.map((beat, b) => `  ${b + 1}. "${beat.say}"`).join('\n')}

${order.length} illustrators drew this board. Score and rank boards ${labels.join(', ')}.`;
        const content: Part[] = [{ type: 'text', text: context }];
        order.forEach((runIndex, i) => {
          content.push({ type: 'text', text: `Board ${labels[i]}:` });
          content.push({
            type: 'image_url',
            image_url: { url: boards.get(boardKey(runIndex, scene))! },
          });
        });
        const call: JudgeCall<(typeof DRAW_CRITERIA)[number]> = { pass, scene, order, entries: [] };
        try {
          const { data, usage } = await judgeRequest({
            auth,
            model,
            system: drawRubric(drawingType),
            schemaName: 'board_scores',
            schema: scoredListSchema('boards', DRAW_CRITERIA, labels),
            content,
          });
          addUsage(judging.spend, usage);
          call.entries = parseJudgeOutput(data, 'boards', DRAW_CRITERIA, order);
          log(`judge  board ${scene + 1} (pass ${pass}) ✓`);
        } catch (error) {
          const usage = (error as { usage?: ProviderUsage }).usage;
          if (usage) addUsage(judging.spend, usage);
          call.error = errorMessage(error);
          log(`judge  board ${scene + 1} (pass ${pass}) FAILED ${call.error}`);
        }
        judging.drawing.push(call);
      }
    }
  }
  return judging;
}
