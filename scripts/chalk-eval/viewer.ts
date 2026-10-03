import {
  buildSceneChrome,
  buildSceneGeometry,
} from '../../utils/chalk/geometry';
import {
  createChalkStyles,
  getBoardTexture,
  paintBackground,
  paintLayerFinished,
} from '../../utils/chalk/paint';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  type ChalkLesson,
  type ChalkSceneDrawing,
} from '../../utils/chalk/types';
import {
  DRAW_CRITERIA,
  listPriceUsd,
  runName,
  summarizeJudging,
  WRITE_CRITERIA,
  type DrawingRun,
  type EvalResults,
  type JudgeCall,
  type Spend,
  type WritingRun,
} from './shared';

declare global {
  interface Window {
    __CHALK_EVAL__: EvalResults;
  }
}

const results = window.__CHALK_EVAL__;
const params = new URLSearchParams(location.search);
const storageKey = `chalk-eval:${results.createdAt}`;

interface SavedState {
  drawOrder: number[];
  writeOrder: number[];
  drawRanks: Record<string, string>;
  writeRanks: Record<string, string>;
  revealed: boolean;
}

function shuffled(count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

function loadState(): SavedState {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as SavedState | null;
    if (
      saved &&
      saved.drawOrder.length === results.drawing.length &&
      saved.writeOrder.length === results.writing.length
    ) {
      return saved;
    }
  } catch {
    // Fall through to a fresh blind order.
  }
  return {
    drawOrder: shuffled(results.drawing.length),
    writeOrder: shuffled(results.writing.length),
    drawRanks: {},
    writeRanks: {},
    revealed: false,
  };
}

const state = loadState();
const save = () => localStorage.setItem(storageKey, JSON.stringify(state));
save();

const letter = (i: number) => String.fromCharCode(65 + i);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

const BOARD_CSS_WIDTH = 360;

function boardCanvas(
  lesson: ChalkLesson,
  sceneIndex: number,
  drawing: ChalkSceneDrawing | null,
  pixelWidth?: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const cssHeight = (BOARD_CSS_WIDTH * BOARD_HEIGHT) / BOARD_WIDTH;
  canvas.style.width = `${BOARD_CSS_WIDTH}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = pixelWidth ?? Math.round(BOARD_CSS_WIDTH * dpr);
  canvas.height = Math.round((canvas.width * BOARD_HEIGHT) / BOARD_WIDTH);
  const ctx = canvas.getContext('2d');
  const scene = lesson.scenes[sceneIndex];
  if (!ctx || !scene) return canvas;
  ctx.setTransform(canvas.width / BOARD_WIDTH, 0, 0, canvas.height / BOARD_HEIGHT, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  paintBackground(ctx, getBoardTexture());
  const chrome = buildSceneChrome(scene, sceneIndex);
  paintLayerFinished(ctx, createChalkStyles(ctx), {
    scene: sceneIndex,
    hazy: false,
    heading: chrome.heading,
    notes: chrome.notes,
    elements: drawing && drawing.elements.length > 0 ? buildSceneGeometry(drawing, sceneIndex) : null,
  });
  return canvas;
}

function rankSelect(
  count: number,
  key: string,
  ranks: Record<string, string>,
): HTMLSelectElement {
  const select = el('select', { 'aria-label': 'Your rank' });
  select.append(el('option', { value: '' }, 'rank…'));
  for (let i = 1; i <= count; i++) select.append(el('option', { value: String(i) }, `#${i}`));
  select.value = ranks[key] ?? '';
  select.addEventListener('change', () => {
    ranks[key] = select.value;
    save();
  });
  return select;
}

function drawingsView(): HTMLElement {
  const reference = results.reference;
  if (!reference || results.drawing.length === 0) {
    return el('p', {}, 'No drawing runs in this eval.');
  }
  const lesson = reference.lesson;
  const reps = Math.max(...results.drawing.map((run) => run.rep));
  const columns = state.drawOrder.map((index) => results.drawing[index]!);
  const table = el('table', { class: 'grid' });
  const head = el('tr', {}, el('th', {}, 'Board'));
  columns.forEach((run, i) => {
    const key = runName(run, reps);
    head.append(
      el(
        'th',
        {},
        el('div', { class: 'col-name' }, state.revealed ? key : `Model ${letter(i)}`),
        rankSelect(columns.length, key, state.drawRanks),
      ),
    );
  });
  table.append(head);

  lesson.scenes.forEach((scene, sceneIndex) => {
    const row = el('tr', {}, el('th', { class: 'row-head' }, `${sceneIndex + 1}. ${scene.heading}`));
    for (const run of columns) {
      const result = run.scenes[sceneIndex];
      const cell = el('td');
      cell.append(boardCanvas(lesson, sceneIndex, result?.drawing ?? null));
      if (!result?.ok) {
        cell.append(
          el(
            'div',
            { class: 'fail', title: result?.errors.join('\n') ?? '' },
            `Draw failed after ${result?.attempts ?? 0} attempt(s); showing notes`,
          ),
        );
      } else if (result.metrics) {
        const m = result.metrics;
        cell.append(
          el(
            'div',
            { class: 'meta' },
            `${m.elements} elements · ${m.textCollisions} text collisions · ${m.textOverFigures} text-on-figure · ${m.emptyBeats} empty beats`,
          ),
        );
      }
      const verdict = state.revealed
        ? judgeVerdict(results.judging?.drawing ?? [], results.drawing.indexOf(run), sceneIndex)
        : null;
      if (verdict) cell.append(el('div', { class: 'judge' }, verdict));
      row.append(cell);
    }
    table.append(row);
  });

  return el(
    'section',
    {},
    el(
      'p',
      { class: 'hint' },
      `Every model drew the same lesson (planned by ${state.revealed ? reference.source : 'one of the writers'}). Boards are shown fully drawn. Collisions are a rough overlap heuristic.`,
    ),
    el('div', { class: 'scroll' }, table),
  );
}

/** The judge's scores and note for one run in one call (board or plan set), per pass. */
function judgeVerdict<C extends string>(
  calls: readonly JudgeCall<C>[],
  runIndex: number,
  scene?: number,
): string | null {
  const lines = calls
    .filter((call) => call.scene === scene && !call.error)
    .flatMap((call) => {
      const entry = call.entries.find((e) => e.run === runIndex);
      if (!entry) return [];
      const values = Object.values(entry.scores) as number[];
      const mean = values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
      return [`Judge: ${mean.toFixed(1)}/10, #${entry.rank} of ${call.order.length}. ${entry.note}`];
    });
  return lines.length ? lines.join('\n') : null;
}

function scriptColumn(run: WritingRun): HTMLElement {
  if (!run.ok || !run.lesson) {
    return el('div', { class: 'fail' }, `Planning failed: ${run.error ?? 'unknown error'}`);
  }
  const lesson = run.lesson;
  const body = el('div', { class: 'script' }, el('h3', {}, lesson.title));
  const verdict = state.revealed
    ? judgeVerdict(results.judging?.writing ?? [], results.writing.indexOf(run))
    : null;
  if (verdict) body.append(el('div', { class: 'judge' }, verdict));
  if (lesson.cast.length) {
    body.append(
      el(
        'p',
        { class: 'cast' },
        `Cast: ${lesson.cast.map((c) => `${c.name} (${c.accessory}) — ${c.role}`).join('; ')}`,
      ),
    );
  }
  lesson.scenes.forEach((scene, i) => {
    body.append(el('h4', {}, `${i + 1}. ${scene.heading}`));
    body.append(el('p', { class: 'visual' }, scene.visual));
    const beats = el('ol', {});
    for (const beat of scene.beats) {
      beats.append(el('li', {}, beat.say, el('span', { class: 'note' }, ` [${beat.note}]`)));
    }
    body.append(beats);
  });
  return body;
}

function scriptsView(): HTMLElement {
  if (results.writing.length === 0) return el('p', {}, 'No writing runs in this eval.');
  const reps = Math.max(...results.writing.map((run) => run.rep));
  const columns = state.writeOrder.map((index) => results.writing[index]!);
  const row = el('div', { class: 'scripts' });
  columns.forEach((run, i) => {
    const key = runName(run, reps);
    row.append(
      el(
        'div',
        { class: 'script-col' },
        el('div', { class: 'col-name' }, state.revealed ? key : `Writer ${letter(i)}`),
        rankSelect(columns.length, key, state.writeRanks),
        scriptColumn(run),
      ),
    );
  });
  return el(
    'section',
    {},
    el('p', { class: 'hint' }, 'Each writer planned the lesson from the same page text. Read for accuracy, teaching flow, and how drawable the art direction is.'),
    el('div', { class: 'scroll' }, row),
  );
}

const fmtUsd = (v: number) => `$${v.toFixed(3)}`;
const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** List-price cost (tokens × OpenRouter price), with the reported charge on hover. */
function costCell(model: string, spend: Spend): HTMLElement {
  const list = listPriceUsd(spend, results.prices?.[model]);
  const reported = `reported ${fmtUsd(spend.costUsd)}${spend.costUnknownCalls ? `, ${spend.costUnknownCalls} unpriced call(s)` : ''} · ${spend.inputTokens} in / ${spend.outputTokens} out tokens`;
  return el('td', { title: reported }, list === null ? `${fmtUsd(spend.costUsd)} reported` : fmtUsd(list));
}

function judgeCells<C extends string>(
  summary: { overall: number; meanRank: number; criteria: Record<C, number> } | undefined,
): HTMLElement[] {
  if (!summary) return [el('td', {}, '—'), el('td', {}, '—')];
  const breakdown = Object.entries(summary.criteria)
    .map(([c, v]) => `${c} ${(v as number).toFixed(1)}`)
    .join(' · ');
  return [
    el('td', { title: breakdown }, summary.overall.toFixed(2)),
    el('td', {}, `#${summary.meanRank.toFixed(1)}`),
  ];
}

function numbersView(): HTMLElement {
  if (!state.revealed) {
    return el('p', { class: 'hint' }, 'Cost and speed give away which model is which. Rank the boards and scripts first, then reveal.');
  }
  const judging = results.judging;
  const drawJudge = new Map(
    judging
      ? summarizeJudging(judging.drawing, DRAW_CRITERIA, results.drawing.length, () =>
          results.drawing.map((_, i) => i),
        ).map((s) => [s.run, s])
      : [],
  );
  const writeJudge = new Map(
    judging
      ? summarizeJudging(judging.writing, WRITE_CRITERIA, results.writing.length, () =>
          results.writing.map((_, i) => i),
        ).map((s) => [s.run, s])
      : [],
  );
  const judgeNote = judging
    ? el(
        'p',
        { class: 'hint' },
        `Judge: ${judging.model}, ${judging.passes} pass(es), $${judging.spend.costUsd.toFixed(3)}. Scores are the mean of ${DRAW_CRITERIA.join('/')} (boards) or ${WRITE_CRITERIA.join('/')} (plans); hover a score for the breakdown. Failed boards count as 1 and last place. The judge may favor its own model's output.`,
      )
    : null;
  const drawTable = el(
    'table',
    { class: 'numbers' },
    el(
      'tr',
      {},
      ...['Drawing model', 'Your rank', 'Judge /10', 'Judge rank', 'Cost', 'Time', 'Drawn', 'Attempts', 'Elements', 'Text collisions', 'Text on figures', 'Empty beats'].map((h) => el('th', {}, h)),
    ),
  );
  const drawReps = Math.max(1, ...results.drawing.map((run) => run.rep));
  results.drawing.forEach((run, runIndex) => {
    const drawn = run.scenes.filter((s) => s.ok);
    const sum = (pick: (s: DrawingRun['scenes'][number]) => number) =>
      drawn.reduce((total, s) => total + pick(s), 0);
    drawTable.append(
      el(
        'tr',
        {},
        el('td', {}, runName(run, drawReps)),
        el('td', {}, state.drawRanks[runName(run, drawReps)] ? `#${state.drawRanks[runName(run, drawReps)]}` : '—'),
        ...judgeCells(drawJudge.get(runIndex)),
        costCell(run.model, run.spend),
        el('td', {}, fmtSec(run.ms)),
        el('td', {}, `${drawn.length}/${run.scenes.length}`),
        el('td', {}, String(run.scenes.reduce((t, s) => t + s.attempts, 0))),
        el('td', {}, String(sum((s) => s.metrics?.elements ?? 0))),
        el('td', {}, String(sum((s) => s.metrics?.textCollisions ?? 0))),
        el('td', {}, String(sum((s) => s.metrics?.textOverFigures ?? 0))),
        el('td', {}, String(sum((s) => s.metrics?.emptyBeats ?? 0))),
      ),
    );
  });
  const writeTable = el(
    'table',
    { class: 'numbers' },
    el(
      'tr',
      {},
      ...['Writing model', 'Your rank', 'Judge /10', 'Judge rank', 'Cost', 'Time', 'Scenes', 'Beats', 'Words', 'Scenes off 2–4 beats', 'Lines > 45 words'].map((h) => el('th', {}, h)),
    ),
  );
  const writeReps = Math.max(1, ...results.writing.map((run) => run.rep));
  results.writing.forEach((run, runIndex) => {
    const m = run.metrics;
    writeTable.append(
      el(
        'tr',
        {},
        el('td', {}, runName(run, writeReps)),
        el('td', {}, state.writeRanks[runName(run, writeReps)] ? `#${state.writeRanks[runName(run, writeReps)]}` : '—'),
        ...judgeCells(writeJudge.get(runIndex)),
        costCell(run.model, run.spend),
        el('td', {}, fmtSec(run.ms)),
        el('td', {}, m ? String(m.scenes) : 'failed'),
        el('td', {}, m ? String(m.beats) : '—'),
        el('td', {}, m ? String(m.words) : '—'),
        el('td', {}, m ? String(m.scenesOffBeatRange) : '—'),
        el('td', {}, m ? String(m.longLines) : '—'),
      ),
    );
  });
  return el('section', {}, judgeNote, writeTable, drawTable);
}

type Tab = 'drawings' | 'scripts' | 'numbers';
let tab: Tab = 'drawings';

function render(): void {
  const app = document.getElementById('app')!;
  app.replaceChildren();
  const tabs = el('nav', { class: 'tabs' });
  for (const [id, label] of [
    ['drawings', 'Drawings'],
    ['scripts', 'Scripts'],
    ['numbers', 'Numbers'],
  ] as const) {
    const button = el('button', { type: 'button', class: id === tab ? 'on' : '' }, label);
    button.addEventListener('click', () => {
      tab = id;
      render();
    });
    tabs.append(button);
  }
  const reveal = el(
    'button',
    { type: 'button', class: 'reveal' },
    state.revealed ? 'Hide models (re-shuffle)' : 'Reveal models',
  );
  reveal.addEventListener('click', () => {
    if (state.revealed) {
      state.drawOrder = shuffled(results.drawing.length);
      state.writeOrder = shuffled(results.writing.length);
    }
    state.revealed = !state.revealed;
    save();
    render();
  });
  app.append(
    el(
      'header',
      {},
      el('h1', {}, 'Chalkboard eval'),
      el('p', { class: 'hint' }, `${results.page.title} · ${results.page.chars} chars · ${results.reportLength} length · ${new Date(results.createdAt).toLocaleString()}`),
      el('div', { class: 'bar' }, tabs, reveal),
    ),
    tab === 'drawings' ? drawingsView() : tab === 'scripts' ? scriptsView() : numbersView(),
  );
}

const style = document.createElement('style');
style.textContent = `
body { margin: 0; padding: 1.25rem; font: 13px/1.45 "Segoe UI", system-ui, sans-serif; background: #d7dbe0; color: #141414; }
h1 { margin: 0 0 .25rem; font-size: 1.3rem; letter-spacing: .14em; text-transform: uppercase; }
.hint { color: #5c636a; margin: .25rem 0 .75rem; }
.bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: .75rem; }
.tabs button, .reveal { border: 2px solid #141414; background: #fff; padding: .35rem .8rem; font: inherit; font-weight: 600; cursor: pointer; margin-right: .35rem; }
.tabs button.on { background: #141414; color: #fff; }
.reveal { background: #e23b2f; color: #fff; border-color: #141414; }
.scroll { overflow-x: auto; }
table.grid { border-collapse: collapse; background: #fff; border: 2px solid #141414; }
table.grid th, table.grid td { border: 1px solid #c9ced4; padding: .4rem; vertical-align: top; text-align: left; }
.row-head { width: 9rem; font-weight: 600; }
.col-name { font-family: ui-monospace, monospace; font-weight: 600; margin-bottom: .25rem; }
canvas { display: block; }
.meta { font-family: ui-monospace, monospace; font-size: 11px; color: #5c636a; margin-top: .25rem; max-width: ${BOARD_CSS_WIDTH}px; }
.fail { color: #e23b2f; font-weight: 600; margin-top: .25rem; }
.scripts { display: flex; gap: .75rem; align-items: flex-start; }
.script-col { flex: 0 0 22rem; background: #fff; border: 2px solid #141414; padding: .6rem; }
.script h3 { margin: .5rem 0; font-size: 1rem; }
.script h4 { margin: .75rem 0 .2rem; }
.visual, .cast { color: #5c636a; font-style: italic; margin: .2rem 0; }
.note { color: #5c636a; font-family: ui-monospace, monospace; font-size: 11px; }
table.numbers { border-collapse: collapse; background: #fff; border: 2px solid #141414; margin-bottom: 1rem; }
table.numbers th, table.numbers td { border: 1px solid #c9ced4; padding: .35rem .6rem; text-align: left; font-variant-numeric: tabular-nums; }
select { font: inherit; }
.judge { font-size: 11px; margin-top: .3rem; padding: .3rem .4rem; border-left: 3px solid #141414; background: #f1f3f5; white-space: pre-line; max-width: ${BOARD_CSS_WIDTH}px; }
`;

/**
 * `?export=1`: paint every drawn board at 1000×600 and write their PNG data
 * URLs into the page, for a single `chrome --dump-dom` run to collect.
 */
function exportBoards(): void {
  const lesson = results.reference?.lesson;
  const images: Record<string, string> = {};
  if (lesson) {
    results.drawing.forEach((run, runIndex) => {
      for (const scene of run.scenes) {
        if (!scene.ok || !scene.drawing) continue;
        const canvas = boardCanvas(lesson, scene.index, scene.drawing, BOARD_WIDTH);
        images[`${runIndex}:${scene.index}`] = canvas.toDataURL('image/png');
      }
    });
  }
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = 'chalk-export';
  block.textContent = JSON.stringify(images);
  document.body.append(block);
}

if (params.get('export') === '1') {
  exportBoards();
} else {
  document.head.append(style);
  render();
}
