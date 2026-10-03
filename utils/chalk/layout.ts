/**
 * Placement of renderer-written parts (speech bubbles, name labels, arrow
 * labels) around the art the model placed. The board is rasterized into a
 * coarse occupancy grid; each movable part takes the candidate spot that
 * covers the least ink, preferring earlier candidates on ties. Pure and
 * deterministic: the same scene always lays out the same way.
 */
import type { Pt } from './geometry';
import { BOARD_HEIGHT, BOARD_WIDTH } from './types';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Where an element's marks sit: text as boxes, strokes as polylines. */
export interface Footprint {
  boxes: readonly Box[];
  strokes: readonly (readonly Pt[])[];
  /** Areas to keep clear that the strokes alone underrate, like the space a stick figure's body spans. */
  zones?: readonly Box[];
}

export interface MovableSpec {
  /** Element the part belongs to. */
  owner: number;
  /** Candidate placements, preferred first. */
  options: readonly Footprint[];
  /** Sits against its owner (a figure's name under its feet), so the owner's own art doesn't count against a spot. */
  attached?: boolean;
}

const CELL = 10;
const COLS = Math.ceil(BOARD_WIDTH / CELL);
const ROWS = Math.ceil(BOARD_HEIGHT / CELL);
const TEXT_WEIGHT = 2;
const STROKE_WEIGHT = 1;
/** Cost of each step down the candidate list, in overlapped stroke cells. */
const OPTION_PENALTY = 1.5;
/** Candidates are scored a little inside their bounds, so merely sharing a cell with a neighbour is free. */
const SCORE_INSET = 3;

function cellIndex(x: number, y: number): number | null {
  const col = Math.floor(x / CELL);
  const row = Math.floor(y / CELL);
  if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return null;
  return row * COLS + col;
}

function boxCells(box: Box, out: (cell: number) => void): void {
  const c0 = Math.max(0, Math.floor(box.x0 / CELL));
  const c1 = Math.min(COLS - 1, Math.floor(box.x1 / CELL));
  const r0 = Math.max(0, Math.floor(box.y0 / CELL));
  const r1 = Math.min(ROWS - 1, Math.floor(box.y1 / CELL));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out(r * COLS + c);
  }
}

function strokeCells(points: readonly Pt[], out: (cell: number) => void): void {
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[i + 1] ?? a;
    if (!a || !b) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2)));
    for (let s = 0; s <= steps; s++) {
      const cell = cellIndex(a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps);
      if (cell !== null) out(cell);
    }
  }
}

/** Cell → weight for a footprint; text outweighs strokes where they share a cell. */
function marks(footprint: Footprint): Map<number, number> {
  const out = new Map<number, number>();
  const put = (weight: number) => (cell: number) => {
    if ((out.get(cell) ?? 0) < weight) out.set(cell, weight);
  };
  for (const zone of footprint.zones ?? []) boxCells(zone, put(STROKE_WEIGHT));
  for (const stroke of footprint.strokes) strokeCells(stroke, put(STROKE_WEIGHT));
  for (const box of footprint.boxes) boxCells(box, put(TEXT_WEIGHT));
  return out;
}

/** Cells a candidate would cover: its areas and text a little inset, plus the cells its strokes pass through. */
function candidateCells(candidate: Footprint): Set<number> {
  const cells = new Set<number>();
  const add = (cell: number) => cells.add(cell);
  for (const area of [...(candidate.zones ?? []), ...candidate.boxes]) {
    boxCells(
      {
        x0: area.x0 + SCORE_INSET,
        y0: area.y0 + SCORE_INSET,
        x1: Math.max(area.x0 + SCORE_INSET, area.x1 - SCORE_INSET),
        y1: Math.max(area.y0 + SCORE_INSET, area.y1 - SCORE_INSET),
      },
      add,
    );
  }
  for (const stroke of candidate.strokes) strokeCells(stroke, add);
  return cells;
}

export function footprintBox(footprint: Footprint): Box | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of footprint.boxes) {
    xs.push(b.x0, b.x1);
    ys.push(b.y0, b.y1);
  }
  for (const stroke of footprint.strokes) {
    for (const [x, y] of stroke) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length === 0) return null;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Picks a candidate for each movable part, in order, so later parts also
 * avoid the ones already placed. `fixed[i]` is element i's own art;
 * `partners[i]` lists elements that share element i's spot on purpose (one
 * erases the other), whose marks it ignores.
 */
export function chooseLayout(
  fixed: readonly Footprint[],
  movables: readonly MovableSpec[],
  partners: readonly (readonly number[])[] = [],
): number[] {
  const occupied = new Float32Array(COLS * ROWS);
  const owned: [number, number][][] = fixed.map(() => []);
  const add = (owner: number, footprint: Footprint) => {
    const list = owned[owner] ?? (owned[owner] = []);
    for (const [cell, weight] of marks(footprint)) {
      occupied[cell] = (occupied[cell] ?? 0) + weight;
      list.push([cell, weight]);
    }
  };
  fixed.forEach((footprint, owner) => add(owner, footprint));
  const art = owned.map((list) => list.slice());

  return movables.map((movable) => {
    const ignore = (partners[movable.owner] ?? []).map((other) => owned[other] ?? []);
    if (movable.attached) ignore.push(art[movable.owner] ?? []);
    let excluded: Float32Array | null = null;
    if (ignore.length > 0) {
      excluded = new Float32Array(COLS * ROWS);
      for (const list of ignore) {
        for (const [cell, weight] of list) excluded[cell] = (excluded[cell] ?? 0) + weight;
      }
    }
    let best = 0;
    let bestCost = Infinity;
    for (let index = 0; index < movable.options.length; index++) {
      let cost = index * OPTION_PENALTY;
      for (const cell of candidateCells(movable.options[index]!)) {
        cost += (occupied[cell] ?? 0) - (excluded?.[cell] ?? 0);
      }      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = index;
      }
    }
    const chosen = movable.options[best];
    if (chosen) add(movable.owner, { boxes: [...chosen.boxes, ...(chosen.zones ?? [])], strokes: chosen.strokes });
    return best;
  });
}
