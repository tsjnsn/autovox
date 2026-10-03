import {
  buildSceneGeometry,
  estimateTextWidth,
  type PaintOp,
} from '../../utils/chalk/geometry';
import type {
  ChalkLesson,
  ChalkSceneDrawing,
} from '../../utils/chalk/types';

export interface LessonMetrics {
  scenes: number;
  beats: number;
  words: number;
  /** Beats per scene outside the prompt's 2–4 range. */
  scenesOffBeatRange: number;
  /** Spoken lines over the prompt's ~45-word budget. */
  longLines: number;
  castSize: number;
}

export interface SceneMetrics {
  elements: number;
  figures: number;
  texts: number;
  /** Beats that add nothing to the board (the drawing ignores that line). */
  emptyBeats: number;
  /** Elements a later beat erases and redraws in place. */
  replaced: number;
  /** Pairs of text from different elements that visibly overlap. */
  textCollisions: number;
  /** Text from one element written over another element's stick figure. */
  textOverFigures: number;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function lessonMetrics(lesson: ChalkLesson): LessonMetrics {
  const beats = lesson.scenes.flatMap((scene) => scene.beats);
  return {
    scenes: lesson.scenes.length,
    beats: beats.length,
    words: beats.reduce((sum, beat) => sum + words(beat.say), 0),
    scenesOffBeatRange: lesson.scenes.filter(
      (scene) => scene.beats.length < 2 || scene.beats.length > 4,
    ).length,
    longLines: beats.filter((beat) => words(beat.say) > 45).length,
    castSize: lesson.cast.length,
  };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

function intersection(a: Box, b: Box): number {
  return area({
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  });
}

/** Overlap as a share of the smaller box, so a tiny label inside a big one counts fully. */
function overlapShare(a: Box, b: Box): number {
  const smaller = Math.min(area(a), area(b));
  return smaller > 0 ? intersection(a, b) / smaller : 0;
}

function textBox(op: Extract<PaintOp, { type: 'text' }>): Box {
  const lines = op.text.split('\n');
  const width = Math.max(
    ...lines.map((line) => estimateTextWidth(line, op.size, op.font)),
  );
  const x0 =
    op.align === 'center'
      ? op.x - width / 2
      : op.align === 'right'
        ? op.x - width
        : op.x;
  const half = op.size / 2;
  return { x0, y0: op.y - half, x1: x0 + width, y1: op.y + half + (lines.length - 1) * op.size };
}

/** Share of the smaller box that must overlap before it reads as a collision. */
const COLLISION_SHARE = 0.2;
/** Stick figures are thin, so a label crossing the body overlaps little area. */
const FIGURE_COLLISION_SHARE = 0.15;

export function sceneMetrics(
  drawing: ChalkSceneDrawing,
  sceneIndex: number,
  beatCount: number,
): SceneMetrics {
  const geometry = buildSceneGeometry(drawing, sceneIndex);
  const texts: { element: number; box: Box }[] = [];
  const figures: { element: number; box: Box }[] = [];
  geometry.forEach((item, element) => {
    // Erased before the scene ends: not on the finished board.
    if (item.replacedBy !== null) return;
    for (const op of item.ops) {
      if (op.type === 'text' && op.text.trim()) {
        texts.push({ element, box: textBox(op) });
      }
    }
    const el = drawing.elements[element];
    if (el?.kind === 'figure') {
      // The body only: a figure's ops also hold its speech bubble's outline.
      const half = el.size * 0.25;
      figures.push({ element, box: { x0: el.x - half, y0: el.y - el.size, x1: el.x + half, y1: el.y } });
    }
  });

  let textCollisions = 0;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      if (a.element !== b.element && overlapShare(a.box, b.box) > COLLISION_SHARE) {
        textCollisions++;
      }
    }
  }
  let textOverFigures = 0;
  for (const text of texts) {
    for (const figure of figures) {
      if (text.element === figure.element) continue;
      if (overlapShare(text.box, figure.box) > FIGURE_COLLISION_SHARE) textOverFigures++;
    }
  }

  const beatsUsed = new Set(drawing.elements.map((element) => element.beat));
  return {
    elements: drawing.elements.length,
    figures: drawing.elements.filter((e) => e.kind === 'figure').length,
    texts: drawing.elements.filter((e) => e.kind === 'text' || e.kind === 'code')
      .length,
    emptyBeats: Array.from({ length: beatCount }, (_, i) => i).filter(
      (beat) => !beatsUsed.has(beat),
    ).length,
    replaced: geometry.filter((item) => item.replacedBy !== null).length,
    textCollisions,
    textOverFigures,
  };
}
