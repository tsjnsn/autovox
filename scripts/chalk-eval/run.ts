/**
 * Chalkboard model eval: plans the same page with several writing models and
 * draws one fixed lesson with several drawing models, through the extension's
 * own pipeline. A judge model then scores every plan and board blind, and a
 * side-by-side viewer is written next to results.json.
 *
 *   pnpm eval:chalk            (reads OPENROUTER_API_KEY from the environment or .env)
 *   pnpm eval:chalk --drawers anthropic/claude-opus-5.5,openai/gpt-6-luna --skip-writing --plan-file .eval/chalk/<run>/results.json
 *   pnpm eval:chalk --extend .eval/chalk/<run> --writers z-ai/glm-5.3 --drawers z-ai/glm-5.3
 *       (copies the run, adds those models on the same page and lesson, re-judges everyone together)
 *   pnpm eval:chalk --judge-only .eval/chalk/<run> --judge-passes 2
 *   pnpm eval:chalk --render-only .eval/chalk/<run>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import type { LlmAuth } from '../../utils/auth';
import { drawLessonScenes, drawScene } from '../../utils/chalk/draw';
import { planLesson } from '../../utils/chalk/lesson';
import type { ChalkLesson } from '../../utils/chalk/types';
import type { ExtractedArticle, ReportLength } from '../../utils/types';
import type { ProviderUsage } from '../../utils/usage';
import { exportBoardImages, judgeEval } from './judge';
import { parseOpenRouterModels } from '../../utils/models';
import { lessonMetrics, sceneMetrics } from './metrics';
import {
  addUsage,
  DRAW_CRITERIA,
  emptySpend,
  errorMessage,
  listPriceUsd,
  runName,
  summarizeJudging,
  usd,
  WRITE_CRITERIA,
  type AttemptStream,
  type DrawingRun,
  type EvalResults,
  type SceneRun,
  type Spend,
  type WritingRun,
} from './shared';
import { approxTokens } from '../../utils/openai';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_WRITERS = [
  'openai/gpt-6-luna',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5.5',
  'openai/gpt-6-sol',
  'google/gemini-3.8-flash',
];
const DEFAULT_DRAWERS = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5',
  'openai/gpt-6-sol',
  'google/gemini-3.8-flash',
  'openai/gpt-6-luna',
];
const DEFAULT_JUDGE = 'anthropic/claude-opus-5.5';
/** A stalled provider otherwise hangs the whole run; a timed-out call counts as a failure. */
const WRITE_TIMEOUT_MS = 5 * 60_000;
/** How often to print streamed token counts for boards still drawing. */
const LIVE_TICK_MS = 10_000;

function usageOf(error: unknown): ProviderUsage | null {
  if (error && typeof error === 'object' && 'usage' in error) {
    return (error as { usage: ProviderUsage }).usage;
  }
  return null;
}

async function runWriting(
  auth: LlmAuth,
  article: ExtractedArticle,
  model: string,
  rep: number,
  reportLength: ReportLength,
): Promise<WritingRun> {
  const spend = emptySpend();
  const start = performance.now();
  try {
    const { lesson, usage } = await planLesson({
      auth,
      model,
      article,
      reportLength,
      outputLanguage: 'auto',
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    addUsage(spend, usage);
    return {
      model,
      rep,
      ok: true,
      ms: performance.now() - start,
      spend,
      lesson,
      metrics: lessonMetrics(lesson),
    };
  } catch (error) {
    const usage = usageOf(error);
    if (usage) addUsage(spend, usage);
    return { model, rep, ok: false, error: errorMessage(error), ms: performance.now() - start, spend };
  }
}

async function runDrawing(
  auth: LlmAuth,
  lesson: ChalkLesson,
  model: string,
  rep: number,
): Promise<DrawingRun> {
  const spend = emptySpend();
  const scenes: SceneRun[] = lesson.scenes.map((_, index) => ({
    index,
    ok: false,
    ms: 0,
    attempts: 0,
    errors: [],
    drawing: null,
  }));
  const start = performance.now();
  /** Latest streamed counts for attempts still in flight, keyed by scene index. */
  const live = new Map<number, AttemptStream & { startedAt: number }>();
  const ticker = setInterval(() => {
    for (const [index, s] of live) {
      const seconds = ((performance.now() - s.startedAt) / 1000).toFixed(0);
      const first = s.firstTokenMs === null ? 'no tokens yet' : `first token ${(s.firstTokenMs / 1000).toFixed(1)}s`;
      console.log(
        `         board ${index + 1} try ${s.attempt}: ${seconds}s · ~${s.reasoningTokens} reasoning + ~${s.outputTokens} output tokens · ${first}`,
      );
    }
  }, LIVE_TICK_MS);
  try {
    await drawLessonScenes({
      auth,
      model,
      lesson,
      outputLanguage: 'auto',
      onUsage: (usage) => addUsage(spend, usage),
      onScene: (index, drawing) => {
        const scene = scenes[index]!;
        scene.ok = true;
        scene.drawing = drawing;
        scene.metrics = sceneMetrics(drawing, index, lesson.scenes[index]!.beats.length);
      },
      onProgress: (index, attempt, progress) => {
        const current = live.get(index);
        if (!current || current.attempt !== attempt) return;
        current.reasoningTokens = approxTokens(progress.reasoningChars);
        current.outputTokens = approxTokens(progress.outputChars);
        current.firstTokenMs = progress.firstTokenMs;
      },
      draw: async (options) => {
        const scene = scenes[options.sceneIndex]!;
        scene.attempts += 1;
        const stream = {
          attempt: scene.attempts,
          reasoningTokens: 0,
          outputTokens: 0,
          firstTokenMs: null,
          ms: 0,
          startedAt: performance.now(),
        };
        live.set(options.sceneIndex, stream);
        try {
          return await drawScene(options);
        } catch (error) {
          scene.errors.push(errorMessage(error));
          (stream as AttemptStream).error = errorMessage(error);
          throw error;
        } finally {
          live.delete(options.sceneIndex);
          stream.ms = performance.now() - stream.startedAt;
          scene.ms = stream.ms;
          const { startedAt: _startedAt, ...record } = stream;
          (scene.streams ??= []).push(record);
        }
      },
    });
  } finally {
    clearInterval(ticker);
  }
  return { model, rep, ms: performance.now() - start, spend, scenes };
}

async function renderViewer(outDir: string, results: EvalResults): Promise<string> {
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: resolve(ROOT, 'scripts/chalk-eval/viewer.ts'),
        formats: ['iife'],
        name: 'ChalkEvalViewer',
        fileName: () => 'viewer.js',
      },
    },
  });
  const data = JSON.stringify(results).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Chalkboard eval — ${results.page.title.replace(/</g, '&lt;')}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div id="app"></div>
<script>window.__CHALK_EVAL__ = ${data};</script>
<script src="./viewer.js"></script>
</body>
</html>
`;
  const htmlPath = resolve(outDir, 'index.html');
  writeFileSync(htmlPath, html);
  return htmlPath;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function saver(outDir: string, results: EvalResults): () => void {
  const path = resolve(outDir, 'results.json');
  return () => writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
}

/** Next rep number for a model, so extending a run never reuses a rep label. */
const nextRep = (runs: readonly { model: string }[], model: string) =>
  runs.filter((run) => run.model === model).length + 1;

async function runWriters(
  auth: LlmAuth,
  article: ExtractedArticle,
  results: EvalResults,
  writers: readonly string[],
  reps: number,
  save: () => void,
): Promise<void> {
  for (let round = 0; round < reps; round++) {
    for (const model of writers) {
      const rep = nextRep(results.writing, model);
      process.stdout.write(`write  ${model} (rep ${rep})… `);
      const writeRun = await runWriting(auth, article, model, rep, results.reportLength);
      results.writing.push(writeRun);
      save();
      console.log(
        writeRun.ok
          ? `${(writeRun.ms / 1000).toFixed(1)}s ${usd(writeRun.spend.costUsd)} · ${writeRun.metrics!.scenes} scenes, ${writeRun.metrics!.words} words`
          : `FAILED ${writeRun.error}`,
      );
    }
  }
}

async function runDrawers(
  auth: LlmAuth,
  results: EvalResults,
  drawers: readonly string[],
  reps: number,
  save: () => void,
): Promise<void> {
  if (drawers.length === 0) return;
  const reference = results.reference;
  if (!reference) {
    console.log('No reference lesson; skipping drawing. Pass --plan-file or include a writer.');
    return;
  }
  console.log(`Drawing the lesson from ${reference.source}: ${reference.lesson.scenes.length} scenes.`);
  for (let round = 0; round < reps; round++) {
    for (const model of drawers) {
      const rep = nextRep(results.drawing, model);
      process.stdout.write(`draw   ${model} (rep ${rep})… `);
      const drawRun = await runDrawing(auth, reference.lesson, model, rep);
      results.drawing.push(drawRun);
      save();
      const drawn = drawRun.scenes.filter((scene) => scene.ok).length;
      console.log(
        `${(drawRun.ms / 1000).toFixed(1)}s ${usd(drawRun.spend.costUsd)} · ${drawn}/${drawRun.scenes.length} scenes drawn`,
      );
      const firstError = drawRun.scenes.flatMap((scene) => scene.errors)[0];
      if (firstError) console.log(`         first error: ${firstError}`);
    }
  }
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadReference(path: string): { source: string; lesson: ChalkLesson } {
  const data = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as
    | EvalResults
    | ChalkLesson;
  if ('reference' in data && data.reference) return data.reference;
  if ('scenes' in data) return { source: path, lesson: data };
  throw new Error(`${path} has no reference lesson`);
}

function loadAuth(): LlmAuth {
  const envFile = resolve(ROOT, '.env');
  if (!process.env.OPENROUTER_API_KEY && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Set OPENROUTER_API_KEY (environment or .env) before running the eval.');
  }
  return { mode: 'openrouter', apiKey, baseUrl: 'https://openrouter.ai/api' };
}

/** Record OpenRouter list prices for every model in the run (public endpoint, no key). */
async function ensurePrices(results: EvalResults): Promise<void> {
  const models = new Set([
    ...results.writing.map((w) => w.model),
    ...results.drawing.map((d) => d.model),
    ...(results.judging ? [results.judging.model] : []),
  ]);
  if ([...models].every((model) => results.prices?.[model])) return;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) return;
    const catalog = parseOpenRouterModels(await response.json());
    const prices = { ...results.prices };
    for (const option of catalog.comprehension) {
      if (models.has(option.id) && option.price) prices[option.id] = option.price;
    }
    results.prices = prices;
  } catch {
    // Prices are informational; the viewer falls back to reported cost.
  }
}

function printCosts(results: EvalResults): void {
  const price = (model: string) => results.prices?.[model];
  const line = (label: string, model: string, spend: Spend) => {
    const list = listPriceUsd(spend, price(model));
    console.log(
      `  ${list === null ? '   n/a  ' : usd(list)}  reported ${usd(spend.costUsd)}  ${spend.inputTokens} in / ${spend.outputTokens} out  ${label}`,
    );
  };
  console.log('\nCost at OpenRouter list price (reported cost is $0 for providers billed through your own keys):');
  for (const w of results.writing) line(`write ${w.model}`, w.model, w.spend);
  for (const d of results.drawing) line(`draw  ${d.model}`, d.model, d.spend);
  if (results.judging) line(`judge ${results.judging.model}`, results.judging.model, results.judging.spend);
}

function printJudging(results: EvalResults): void {
  const judging = results.judging;
  if (!judging) return;
  const writeReps = Math.max(1, ...results.writing.map((w) => w.rep));
  const drawReps = Math.max(1, ...results.drawing.map((d) => d.rep));
  const writing = summarizeJudging(judging.writing, WRITE_CRITERIA, results.writing.length, () =>
    results.writing.map((_, i) => i),
  );
  const drawing = summarizeJudging(judging.drawing, DRAW_CRITERIA, results.drawing.length, () =>
    results.drawing.map((_, i) => i),
  );
  console.log(`\nJudge: ${judging.model}, ${judging.passes} pass(es), ${usd(judging.spend.costUsd)}`);
  console.log('Writing (overall /10, mean rank):');
  for (const s of writing) {
    console.log(
      `  ${s.overall.toFixed(2)}  #${s.meanRank.toFixed(1)}  ${runName(results.writing[s.run]!, writeReps)}${s.missing ? `  (${s.missing} failed)` : ''}`,
    );
  }
  console.log('Drawing (overall /10, mean rank):');
  for (const s of drawing) {
    console.log(
      `  ${s.overall.toFixed(2)}  #${s.meanRank.toFixed(1)}  ${runName(results.drawing[s.run]!, drawReps)}${s.missing ? `  (${s.missing} boards failed)` : ''}`,
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      page: { type: 'string', default: '.eval/pages/econ-augment.json' },
      writers: { type: 'string' },
      drawers: { type: 'string' },
      'plan-from': { type: 'string', default: 'openai/gpt-6-luna' },
      'plan-file': { type: 'string' },
      'skip-writing': { type: 'boolean', default: false },
      reps: { type: 'string', default: '1' },
      length: { type: 'string', default: 'standard' },
      out: { type: 'string' },
      judge: { type: 'string', default: DEFAULT_JUDGE },
      'judge-passes': { type: 'string', default: '1' },
      'judge-only': { type: 'string' },
      'render-only': { type: 'string' },
      extend: { type: 'string' },
    },
  });

  if (values['render-only']) {
    const dir = resolve(ROOT, values['render-only']);
    const resultsFile = resolve(dir, 'results.json');
    const results = JSON.parse(readFileSync(resultsFile, 'utf8')) as EvalResults;
    await ensurePrices(results);
    writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
    printCosts(results);
    printJudging(results);
    console.log(`Viewer: ${await renderViewer(dir, results)}`);
    return;
  }

  const auth = loadAuth();
  const judgeModel = values.judge === 'none' ? null : values.judge;
  const judgePasses = Math.max(1, Number.parseInt(values['judge-passes'], 10) || 1);

  let outDir: string;
  let results: EvalResults;
  let article: ExtractedArticle | null;

  if (values['judge-only']) {
    outDir = resolve(ROOT, values['judge-only']);
    results = JSON.parse(readFileSync(resolve(outDir, 'results.json'), 'utf8')) as EvalResults;
    const pagePath = results.page.path ? resolve(ROOT, results.page.path) : null;
    article =
      pagePath && existsSync(pagePath)
        ? (JSON.parse(readFileSync(pagePath, 'utf8')) as ExtractedArticle)
        : null;
  } else if (values.extend) {
    const source = resolve(ROOT, values.extend);
    results = JSON.parse(readFileSync(resolve(source, 'results.json'), 'utf8')) as EvalResults;
    const pagePath = results.page.path ? resolve(ROOT, results.page.path) : null;
    if (!pagePath || !existsSync(pagePath)) {
      throw new Error(`${values.extend} does not record a readable page file`);
    }
    article = JSON.parse(readFileSync(pagePath, 'utf8')) as ExtractedArticle;
    outDir = resolve(ROOT, values.out ?? `.eval/chalk/${stamp()}`);
    mkdirSync(outDir, { recursive: true });
    // A fresh timestamp gives the viewer a fresh blind order and rankings.
    results.createdAt = new Date().toISOString();
    delete results.judging;
    const save = saver(outDir, results);
    save();
    console.log(`Extending ${relative(ROOT, source)} into ${relative(ROOT, outDir)}.`);
    const reps = Math.max(1, Number.parseInt(values.reps, 10) || 1);
    await runWriters(auth, article, results, list(values.writers, []), reps, save);
    await runDrawers(auth, results, list(values.drawers, []), reps, save);
  } else {
    const pagePath = resolve(ROOT, values.page);
    article = JSON.parse(readFileSync(pagePath, 'utf8')) as ExtractedArticle;
    const reportLength = values.length as ReportLength;
    const reps = Math.max(1, Number.parseInt(values.reps, 10) || 1);
    const writers = values['skip-writing'] ? [] : list(values.writers, DEFAULT_WRITERS);
    const drawers = list(values.drawers, DEFAULT_DRAWERS);
    outDir = resolve(ROOT, values.out ?? `.eval/chalk/${stamp()}`);
    mkdirSync(outDir, { recursive: true });

    results = {
      createdAt: new Date().toISOString(),
      page: {
        title: article.title,
        url: article.url,
        chars: article.textContent.length,
        path: relative(ROOT, pagePath),
      },
      reportLength,
      writing: [],
      reference: null,
      drawing: [],
    };
    const save = saver(outDir, results);

    await runWriters(auth, article, results, writers, reps, save);

    if (values['plan-file']) {
      results.reference = loadReference(values['plan-file']);
    } else {
      const planFrom = values['plan-from'];
      const source =
        results.writing.find((w) => w.ok && w.model === planFrom) ??
        results.writing.find((w) => w.ok);
      if (source?.lesson) {
        results.reference = { source: `${source.model} (rep ${source.rep})`, lesson: source.lesson };
      }
    }
    save();

    await runDrawers(auth, results, drawers, reps, save);
  }

  const resultsPath = resolve(outDir, 'results.json');
  const save = saver(outDir, results);
  await renderViewer(outDir, results);

  if (judgeModel) {
    console.log(`Rendering boards for the judge…`);
    const boards = results.drawing.length ? await exportBoardImages(outDir) : new Map<string, string>();
    results.judging = await judgeEval({
      auth,
      model: judgeModel,
      passes: judgePasses,
      results,
      article,
      boards,
      log: (line) => console.log(line),
    });
    save();
  }

  await ensurePrices(results);
  save();
  printCosts(results);
  printJudging(results);
  const total =
    results.writing.reduce((sum, w) => sum + w.spend.costUsd, 0) +
    results.drawing.reduce((sum, d) => sum + d.spend.costUsd, 0) +
    (results.judging?.spend.costUsd ?? 0);
  console.log(`\nReported spend: ${usd(total)}`);
  console.log(`Results: ${resultsPath}`);
  console.log(`Viewer:  ${await renderViewer(outDir, results)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
