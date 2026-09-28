/**
 * Pure chalk geometry: turns sanitized ChalkElements (plus the renderer's own
 * heading and fallback notes) into ordered paint ops in board units. No DOM.
 *
 * Hand-drawn wobble comes from a seeded RNG, so the same element always
 * produces the same ops and frames never shimmer.
 */
import {
  BOARD_HEADING_BAND,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  type ChalkAccessory,
  type ChalkColor,
  type ChalkElement,
  type ChalkFace,
  type ChalkPose,
  type ChalkScene,
  type ChalkSceneDrawing,
} from './types';

export type Pt = [number, number];
export type ChalkFont = 'hand' | 'mono';
export type TextAlign = 'left' | 'center' | 'right';

export interface StrokeOp {
  type: 'stroke';
  points: Pt[];
  color: ChalkColor;
  /** Polyline length in board units. */
  ink: number;
  /** Line width multiplier (1 = normal chalk). */
  weight: number;
  /** Opacity multiplier. */
  alpha: number;
}

export interface TextOp {
  type: 'text';
  /** Anchor per `align`; y is the vertical middle of the line. */
  x: number;
  y: number;
  /** Font height in board units. */
  size: number;
  text: string;
  font: ChalkFont;
  color: ChalkColor;
  align: TextAlign;
  /** ≈ chars × size × 0.55. */
  ink: number;
  alpha: number;
}

export type PaintOp = StrokeOp | TextOp;

export interface ElementGeometry {
  beat: number;
  color: ChalkColor;
  ops: PaintOp[];
  ink: number;
}

/** Renderer-written parts of a scene: its heading and per-beat fallback notes. */
export interface SceneChrome {
  heading: PaintOp[];
  notes: PaintOp[][];
  noteInks: number[];
}

export interface OpSlice {
  op: PaintOp;
  /** 1 for fully drawn ops; the last slice may be partial. */
  fraction: number;
}

/** Estimated glyph advance (em) for the hand and mono font stacks. */
export const HAND_ADVANCE = 0.55;
export const MONO_ADVANCE = 0.6;
/** Text keeps at least this far from the board edges. */
export const TEXT_MARGIN = 8;

export const HEADING_Y = 38;
export const NOTE_X = 60;
export const NOTE_COLUMN_X = 520;
export const NOTE_TOP = 120;
export const NOTE_ROW = 52;
export const NOTE_SIZE = 30;
const NOTE_BOTTOM = BOARD_HEIGHT - 44;
const NOTE_ROWS = Math.floor((NOTE_BOTTOM - NOTE_TOP) / NOTE_ROW) + 1;

type Rng = () => number;

type FigureElement = Extract<ChalkElement, { kind: 'figure' }>;
type BoxElement = Extract<ChalkElement, { kind: 'box' }>;
type CircleElement = Extract<ChalkElement, { kind: 'circle' }>;
type ArrowElement = Extract<ChalkElement, { kind: 'arrow' }>;
type CodeElement = Extract<ChalkElement, { kind: 'code' }>;

// ---------------------------------------------------------------- numbers

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Small, fast deterministic PRNG (0..1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed for element `index` of scene `scene`. */
export function chalkSeed(scene: number, index: number): number {
  let h = 2166136261 ^ Math.imul(scene + 1, 0x9e3779b1);
  h = Math.imul(h ^ (index + 1), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

// ---------------------------------------------------------------- reveal math

export function polylineLength(points: readonly Pt[]): number {
  let len = 0;
  let prev: Pt | null = null;
  for (const p of points) {
    if (prev) len += dist(prev, p);
    prev = p;
  }
  return len;
}

/** Prefix of a polyline covering `fraction` of its arc length. */
export function truncatePolyline(points: readonly Pt[], fraction: number): Pt[] {
  const first = points[0];
  if (!first) return [];
  if (fraction >= 1) return points.slice();
  if (!(fraction > 0)) return [first];
  const target = polylineLength(points) * fraction;
  const out: Pt[] = [first];
  let acc = 0;
  let prev = first;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (!p) break;
    const seg = dist(prev, p);
    if (acc + seg >= target) {
      const k = seg > 0 ? (target - acc) / seg : 0;
      out.push([prev[0] + (p[0] - prev[0]) * k, prev[1] + (p[1] - prev[1]) * k]);
      return out;
    }
    out.push(p);
    acc += seg;
    prev = p;
  }
  return out;
}

/** Characters of `text` shown at `fraction` (code-point aware). */
export function revealedChars(text: string, fraction: number): number {
  const total = Array.from(text).length;
  return Math.floor(total * clamp(fraction, 0, 1));
}

export function opsInk(ops: readonly PaintOp[]): number {
  let ink = 0;
  for (const op of ops) ink += op.ink;
  return ink;
}

export function estimateTextWidth(text: string, size: number, font: ChalkFont = 'hand'): number {
  return Array.from(text).length * size * (font === 'mono' ? MONO_ADVANCE : HAND_ADVANCE);
}

/** Estimated point where the chalk sits after drawing `fraction` of `op`. */
export function opPoint(op: PaintOp, fraction: number): Pt {
  if (op.type === 'stroke') {
    const pts = truncatePolyline(op.points, fraction);
    return pts[pts.length - 1] ?? [0, 0];
  }
  const width = estimateTextWidth(op.text, op.size, op.font);
  const left = op.align === 'left' ? op.x : op.align === 'center' ? op.x - width / 2 : op.x - width;
  const shown = revealedChars(op.text, fraction);
  const advance = op.font === 'mono' ? MONO_ADVANCE : HAND_ADVANCE;
  return [left + shown * op.size * advance, op.y + op.size * 0.3];
}

/**
 * Splits ops into what is visible at `fraction` of their total ink: fully
 * drawn ops, then at most one partial op. `pen` is where the chalk is, or null
 * once everything is drawn.
 */
export function revealSlices(
  ops: readonly PaintOp[],
  fraction: number,
): { slices: OpSlice[]; pen: Pt | null } {
  if (!(fraction > 0) || ops.length === 0) return { slices: [], pen: null };
  if (fraction >= 1) {
    return { slices: ops.map((op) => ({ op, fraction: 1 })), pen: null };
  }
  let budget = opsInk(ops) * fraction;
  const slices: OpSlice[] = [];
  let pen: Pt | null = null;
  for (const op of ops) {
    if (budget <= 0) break;
    if (op.ink <= budget) {
      slices.push({ op, fraction: 1 });
      budget -= op.ink;
      pen = opPoint(op, 1);
      continue;
    }
    const f = budget / op.ink;
    slices.push({ op, fraction: f });
    pen = opPoint(op, f);
    break;
  }
  return { slices, pen };
}

// ---------------------------------------------------------------- hand-drawn primitives

/** A line with gentle low-frequency wobble and slightly loose endpoints. */
function handLine(a: Pt, b: Pt, rng: Rng, amp = 1): Pt[] {
  const len = dist(a, b);
  if (len < 0.5) return [a, [a[0] + 0.3, a[1] + 0.3]];
  const n = Math.max(2, Math.ceil(len / 22));
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const wob = Math.min(2.2, 0.35 + len * 0.012) * amp;
  const f1 = 1 + rng() * 1.5;
  const f2 = 2.5 + rng() * 2.5;
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const bow = (rng() - 0.5) * wob * 1.4;
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const env = 0.3 + 0.7 * Math.sin(Math.PI * s);
    const off =
      wob * (0.6 * Math.sin(f1 * Math.PI * s + p1) + 0.4 * Math.sin(f2 * Math.PI * s + p2)) * env +
      bow * Math.sin(Math.PI * s);
    pts.push([a[0] + (b[0] - a[0]) * s + nx * off, a[1] + (b[1] - a[1]) * s + ny * off]);
  }
  return pts;
}

function handPolyline(points: readonly Pt[], rng: Rng, amp = 1): Pt[] {
  const out: Pt[] = [];
  let prev: Pt | null = null;
  for (const p of points) {
    if (prev) {
      const seg = handLine(prev, p, rng, amp);
      if (out.length > 0) seg.shift();
      out.push(...seg);
    }
    prev = p;
  }
  if (out.length === 0 && points[0]) out.push(points[0], [points[0][0] + 0.3, points[0][1]]);
  return out;
}

/** Hand-drawn ellipse: random start, slight wobble, spirals past the start. */
function handEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rng: Rng,
  overshoot = 0.35,
  wobble = 0.03,
): Pt[] {
  const a0 = rng() * Math.PI * 2;
  const sweep = Math.PI * 2 + overshoot;
  const n = Math.max(14, Math.ceil((Math.PI * (rx + ry)) / 8));
  const ph = rng() * Math.PI * 2;
  const spiral = overshoot > 0 ? 0.03 + rng() * 0.03 : 0;
  const tilt = (rng() - 0.5) * 0.12;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const th = a0 + sweep * s;
    const m = 1 + wobble * Math.sin(2 * th + ph) + spiral * (s - 0.5);
    const lx = rx * m * Math.cos(th);
    const ly = ry * m * Math.sin(th);
    pts.push([cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]);
  }
  return pts;
}

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, n = 10): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function roundedRectPts(x: number, y: number, w: number, h: number, radius: number): Pt[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const corners: Array<[number, number, number]> = [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ];
  const pts: Pt[] = [];
  for (const [cx, cy, a0] of corners) {
    pts.push(...arcPts(cx, cy, r, a0, a0 + Math.PI / 2, 4));
  }
  const first = pts[0];
  if (first) pts.push([first[0], first[1]]);
  return pts;
}

/** Centripetal-free (uniform) Catmull-Rom through the points. */
function smoothPath(points: readonly Pt[], closed: boolean): Pt[] {
  const n = points.length;
  if (n < 3) return points.slice();
  const get = (i: number): Pt => {
    const idx = closed ? ((i % n) + n) % n : clamp(i, 0, n - 1);
    return points[idx] ?? [0, 0];
  };
  const segments = closed ? n : n - 1;
  const out: Pt[] = [];
  for (let s = 0; s < segments; s++) {
    const p0 = get(s - 1);
    const p1 = get(s);
    const p2 = get(s + 1);
    const p3 = get(s + 2);
    const steps = Math.max(4, Math.ceil(dist(p1, p2) / 10));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(get(segments));
  return out;
}

function quadAt(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/** Greedy word wrap; explicit newlines are kept, over-long words are split. */
export function wrapText(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const raw of para.split(/\s+/).filter(Boolean)) {
      let word = raw;
      while (word.length > limit) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, limit));
        word = word.slice(limit);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Picks a font size (and up to three lines) so a label fits maxW × maxH. */
export function fitLabel(
  text: string,
  maxW: number,
  maxH: number,
  preferred: number,
): { lines: string[]; size: number } {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return { lines: [], size: preferred };
  const w = Math.max(20, maxW);
  const h = Math.max(12, maxH);
  let best: { lines: string[]; size: number } = { lines: [clean], size: 0 };
  for (let count = 1; count <= 3; count++) {
    const lines = count === 1 ? [clean] : wrapText(clean, Math.ceil(clean.length / count));
    const longest = Math.max(1, ...lines.map((l) => l.length));
    const size = Math.min(preferred, w / (longest * HAND_ADVANCE), h / (lines.length * 1.15));
    if (size > best.size + 0.5) best = { lines, size };
    if (size >= Math.min(preferred, 18)) break;
  }
  return { lines: best.lines, size: clamp(best.size, 11, preferred) };
}

/** Shifts a text anchor so its estimated extent stays inside the board. */
function fitAnchorX(x: number, width: number, align: TextAlign): number {
  const left = align === 'left' ? x : align === 'center' ? x - width / 2 : x - width;
  const maxLeft = BOARD_WIDTH - TEXT_MARGIN - width;
  const nextLeft = maxLeft < TEXT_MARGIN ? TEXT_MARGIN : clamp(left, TEXT_MARGIN, maxLeft);
  return x + (nextLeft - left);
}

function clampPt(p: Pt): Pt {
  return [clamp(p[0], 1, BOARD_WIDTH - 1), clamp(p[1], 1, BOARD_HEIGHT - 1)];
}

function finitePt(p: Pt): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

/** Accumulates ops in draw order; clamps strokes into the board. */
class OpList {
  readonly list: PaintOp[] = [];
  color: ChalkColor;

  constructor(color: ChalkColor) {
    this.color = color;
  }

  stroke(points: readonly Pt[], weight = 1, alpha = 1): void {
    const pts = points.filter(finitePt).map(clampPt);
    const first = pts[0];
    if (!first) return;
    if (pts.length === 1) pts.push([first[0] + 0.3, first[1]]);
    this.list.push({
      type: 'stroke',
      points: pts,
      color: this.color,
      ink: Math.max(1, polylineLength(pts)),
      weight,
      alpha,
    });
  }

  text(
    x: number,
    y: number,
    size: number,
    text: string,
    font: ChalkFont,
    align: TextAlign,
    alpha = 1,
  ): void {
    const clean = text.replace(/\s+$/, '');
    if (!clean || !Number.isFinite(x) || !Number.isFinite(y) || !(size > 0)) return;
    const width = estimateTextWidth(clean, size, font);
    this.list.push({
      type: 'text',
      x: fitAnchorX(x, width, align),
      y: clamp(y, size * 0.55, BOARD_HEIGHT - size * 0.55),
      size,
      text: clean,
      font,
      color: this.color,
      align,
      ink: Math.max(1, Array.from(clean).length * size * HAND_ADVANCE),
      alpha,
    });
  }

  /** Centered, auto-fitted label (box/circle/arrow captions). */
  label(text: string, cx: number, cy: number, maxW: number, maxH: number, preferred: number): void {
    const { lines, size } = fitLabel(text, maxW, maxH, preferred);
    const gap = size * 1.15;
    const top = cy - ((lines.length - 1) * gap) / 2;
    lines.forEach((line, i) => this.text(cx, top + i * gap, size, line, 'hand', 'center'));
  }
}

// ---------------------------------------------------------------- figure

interface PoseShape {
  head: Pt;
  neck: Pt;
  hip: Pt;
  /** Arms, then legs, as polylines. */
  limbs: Pt[][];
  /** Extra marks: stool, wave lines. */
  props: Pt[][];
}

const HEAD_R = 0.11;
const ARM_DOWN_L: Pt[] = [
  [0, -0.7],
  [-0.1, -0.53],
  [-0.15, -0.38],
];
const ARM_DOWN_R: Pt[] = mirror(ARM_DOWN_L);
const LEGS_STAND: Pt[][] = [
  [
    [0, -0.38],
    [-0.12, 0],
  ],
  [
    [0, -0.38],
    [0.12, 0],
  ],
];

function mirror(points: readonly Pt[]): Pt[] {
  return points.map(([x, y]) => [-x, y]);
}

function standing(arms: Pt[][], legs: Pt[][] = LEGS_STAND, props: Pt[][] = []): PoseShape {
  return { head: [0, -1 + HEAD_R], neck: [0, -0.78], hip: [0, -0.38], limbs: [...arms, ...legs], props };
}

/** Pose skeleton in figure units: height 1, feet at y = 0, y up is negative. */
function poseShape(pose: ChalkPose): PoseShape {
  switch (pose) {
    case 'point_left':
    case 'point_right':
      // Drawn pointing right; the caller mirrors point_left.
      return standing([
        ARM_DOWN_L,
        [
          [0, -0.7],
          [0.18, -0.73],
          [0.36, -0.77],
        ],
      ]);
    case 'arms_up': {
      const up: Pt[] = [
        [0, -0.7],
        [-0.13, -0.83],
        [-0.19, -0.99],
      ];
      return standing([up, mirror(up)]);
    }
    case 'think':
      return standing([
        ARM_DOWN_L,
        [
          [0, -0.7],
          [0.16, -0.57],
          [0.06, -0.79],
        ],
      ]);
    case 'walk':
      return {
        head: [0.02, -1 + HEAD_R],
        neck: [0.015, -0.78],
        hip: [0, -0.38],
        limbs: [
          [
            [0.015, -0.7],
            [-0.08, -0.55],
            [-0.15, -0.43],
          ],
          [
            [0.015, -0.7],
            [0.09, -0.56],
            [0.18, -0.47],
          ],
          [
            [0, -0.38],
            [0.09, -0.2],
            [0.17, 0],
          ],
          [
            [0, -0.38],
            [-0.04, -0.2],
            [-0.16, -0.03],
          ],
        ],
        props: [],
      };
    case 'sit':
      return {
        head: [0, -0.86 + HEAD_R],
        neck: [0, -0.64],
        hip: [-0.02, -0.26],
        limbs: [
          [
            [0, -0.57],
            [0.07, -0.42],
            [0.16, -0.3],
          ],
          [
            [0, -0.57],
            [0.04, -0.41],
            [0.12, -0.32],
          ],
          [
            [-0.02, -0.26],
            [0.17, -0.26],
            [0.18, 0],
            [0.23, 0],
          ],
          [
            [-0.02, -0.26],
            [0.14, -0.24],
            [0.13, 0],
            [0.18, 0],
          ],
        ],
        props: [
          [
            [-0.15, -0.23],
            [0.05, -0.23],
          ],
          [
            [-0.13, -0.23],
            [-0.14, 0],
          ],
          [
            [0.03, -0.23],
            [0.04, 0],
          ],
        ],
      };
    case 'wave': {
      const hand: Pt = [0.21, -0.97];
      return standing(
        [
          ARM_DOWN_L,
          [
            [0, -0.7],
            [0.17, -0.79],
            hand,
          ],
        ],
        LEGS_STAND,
        [arcPts(hand[0], hand[1], 0.07, -1.25, -0.15, 5), arcPts(hand[0], hand[1], 0.11, -1.25, -0.15, 6)],
      );
    }
    case 'shrug': {
      const arm: Pt[] = [
        [0, -0.71],
        [-0.15, -0.6],
        [-0.25, -0.7],
      ];
      return standing([arm, mirror(arm)]);
    }
    case 'hold':
      return standing([
        [
          [0, -0.7],
          [0.11, -0.57],
          [0.25, -0.59],
        ],
        [
          [0, -0.7],
          [0.14, -0.63],
          [0.26, -0.67],
        ],
      ]);
    case 'stand':
    default:
      return standing([ARM_DOWN_L, ARM_DOWN_R]);
  }
}

function faceOps(ops: OpList, face: ChalkFace, hx: number, hy: number, r: number, rng: Rng): void {
  const w = clamp(r / 13, 0.45, 1);
  const eyeY = hy - 0.12 * r;
  for (const s of [-1, 1]) {
    const ex = hx + s * 0.38 * r;
    ops.stroke(
      [
        [ex - 0.03 * r, eyeY],
        [ex + 0.03 * r, eyeY + 0.02 * r],
      ],
      w * 1.1,
    );
  }
  switch (face) {
    case 'happy':
      ops.stroke(arcPts(hx, hy + 0.02 * r, 0.52 * r, 0.22 * Math.PI, 0.78 * Math.PI, 8), w);
      break;
    case 'sad':
      ops.stroke(arcPts(hx, hy + 0.9 * r, 0.45 * r, 1.25 * Math.PI, 1.75 * Math.PI, 8), w);
      break;
    case 'surprised':
      ops.stroke(handEllipse(hx, hy + 0.45 * r, 0.17 * r, 0.2 * r, rng, 0.2, 0.02), w);
      for (const s of [-1, 1]) {
        const ex = hx + s * 0.38 * r;
        ops.stroke(arcPts(ex, eyeY - 0.05 * r, 0.22 * r, 1.2 * Math.PI, 1.8 * Math.PI, 5), w * 0.8);
      }
      break;
    case 'confused':
      ops.stroke(
        [
          [hx - 0.3 * r, hy + 0.5 * r],
          [hx - 0.1 * r, hy + 0.4 * r],
          [hx + 0.1 * r, hy + 0.5 * r],
          [hx + 0.3 * r, hy + 0.4 * r],
        ],
        w,
      );
      ops.stroke(
        [
          [hx + 0.2 * r, eyeY - 0.28 * r],
          [hx + 0.58 * r, eyeY - 0.42 * r],
        ],
        w * 0.8,
      );
      break;
    case 'neutral':
    default:
      ops.stroke(
        [
          [hx - 0.28 * r, hy + 0.45 * r],
          [hx + 0.28 * r, hy + 0.46 * r],
        ],
        w,
      );
  }
}

function accessoryOps(
  ops: OpList,
  accessory: ChalkAccessory,
  hx: number,
  hy: number,
  r: number,
  neck: Pt,
  h: number,
  rng: Rng,
): void {
  const top = hy - r;
  const w = clamp(r / 13, 0.55, 1);
  switch (accessory) {
    case 'hat':
      ops.stroke(handLine([hx - 1.35 * r, top + 0.05 * r], [hx + 1.35 * r, top + 0.05 * r], rng, 0.5), w);
      ops.stroke(
        handPolyline(
          [
            [hx - 0.8 * r, top],
            [hx - 0.75 * r, top - 1.2 * r],
            [hx + 0.75 * r, top - 1.2 * r],
            [hx + 0.8 * r, top],
          ],
          rng,
          0.5,
        ),
        w,
      );
      ops.stroke(handLine([hx - 0.78 * r, top - 0.3 * r], [hx + 0.78 * r, top - 0.3 * r], rng, 0.3), w * 0.8);
      break;
    case 'cap':
      ops.stroke(arcPts(hx, hy - 0.2 * r, 1.02 * r, 1.03 * Math.PI, 1.97 * Math.PI, 10), w);
      ops.stroke(handLine([hx - 1.02 * r, hy - 0.22 * r], [hx + 1.8 * r, hy - 0.2 * r], rng, 0.4), w);
      break;
    case 'glasses':
      for (const s of [-1, 1]) {
        ops.stroke(handEllipse(hx + s * 0.38 * r, hy - 0.12 * r, 0.28 * r, 0.24 * r, rng, 0.2, 0.02), w * 0.75);
      }
      ops.stroke(
        [
          [hx - 0.1 * r, hy - 0.16 * r],
          [hx + 0.1 * r, hy - 0.16 * r],
        ],
        w * 0.75,
      );
      break;
    case 'bow': {
      const bx = hx + 0.6 * r;
      const by = top + 0.15 * r;
      for (const s of [-1, 1]) {
        ops.stroke(
          [
            [bx, by],
            [bx + s * 0.55 * r, by - 0.38 * r],
            [bx + s * 0.55 * r, by + 0.32 * r],
            [bx, by],
          ],
          w * 0.85,
        );
      }
      ops.stroke(handEllipse(bx, by, 0.09 * r, 0.09 * r, rng, 0.2, 0), w * 0.85);
      break;
    }
    case 'tie': {
      const [nx, ny] = neck;
      const tw = 0.045 * h;
      ops.stroke(
        [
          [nx - tw * 0.6, ny + 0.01 * h],
          [nx + tw * 0.6, ny + 0.01 * h],
          [nx + tw, ny + 0.16 * h],
          [nx, ny + 0.21 * h],
          [nx - tw, ny + 0.16 * h],
          [nx - tw * 0.6, ny + 0.01 * h],
        ],
        w * 0.85,
      );
      break;
    }
    case 'crown':
      ops.stroke(
        handPolyline(
          [
            [hx - 0.8 * r, top + 0.1 * r],
            [hx - 0.85 * r, top - 0.8 * r],
            [hx - 0.4 * r, top - 0.35 * r],
            [hx, top - 0.95 * r],
            [hx + 0.4 * r, top - 0.35 * r],
            [hx + 0.85 * r, top - 0.8 * r],
            [hx + 0.8 * r, top + 0.1 * r],
            [hx - 0.8 * r, top + 0.1 * r],
          ],
          rng,
          0.3,
        ),
        w,
      );
      break;
    case 'beard':
      ops.stroke(
        handPolyline(
          [
            [hx - 0.95 * r, hy + 0.15 * r],
            [hx - 0.65 * r, hy + 1.05 * r],
            [hx, hy + 1.45 * r],
            [hx + 0.65 * r, hy + 1.05 * r],
            [hx + 0.95 * r, hy + 0.15 * r],
          ],
          rng,
          0.3,
        ),
        w,
      );
      for (const s of [-0.4, 0, 0.4]) {
        ops.stroke(
          [
            [hx + s * r, hy + 0.85 * r],
            [hx + s * r * 1.1, hy + 1.15 * r],
          ],
          w * 0.6,
          0.7,
        );
      }
      break;
    case 'none':
    default:
      break;
  }
}

function speechBubbleOps(ops: OpList, text: string, hx: number, hy: number, r: number, figSize: number, rng: Rng): void {
  const size = clamp(figSize * 0.1, 14, 18);
  let lines = wrapText(text.trim(), 22);
  if (lines.length > 4) {
    lines = lines.slice(0, 4);
    lines[3] = `${(lines[3] ?? '').replace(/\s*\S{0,2}$/, '')}…`;
  }
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const pad = size * 0.6;
  const w = longest * size * HAND_ADVANCE + pad * 2;
  const h = lines.length * size * 1.2 + pad * 1.4;
  let left = hx + r * 0.9;
  if (left + w > BOARD_WIDTH - TEXT_MARGIN) left = hx - r * 0.9 - w;
  left = clamp(left, TEXT_MARGIN, Math.max(TEXT_MARGIN, BOARD_WIDTH - TEXT_MARGIN - w));
  const top = clamp(
    hy - r * 0.9 - h,
    BOARD_HEADING_BAND + 4,
    Math.max(BOARD_HEADING_BAND + 4, BOARD_HEIGHT - TEXT_MARGIN - h),
  );
  const bottom = top + h;
  const toRight = left + w / 2 >= hx;

  ops.stroke(handPolyline(roundedRectPts(left, top, w, h, Math.min(14, h / 3)), rng, 0.35), 0.85);
  if (bottom <= hy - r * 0.4) {
    // Bubble above the head: tail from the bottom edge down toward the head.
    const bx = clamp(hx + (toRight ? 1 : -1) * r, left + 14, left + w - 14);
    ops.stroke(
      [
        [bx - 7, bottom],
        [hx + (toRight ? 0.7 : -0.7) * r, hy - r * 1.05],
        [bx + 7, bottom],
      ],
      0.85,
    );
  } else {
    // Bubble beside the head: tail from the near side edge.
    const edge = toRight ? left : left + w;
    const ty = clamp(hy, top + 10, bottom - 10);
    ops.stroke(
      [
        [edge, ty - 6],
        [hx + (toRight ? 1.15 : -1.15) * r, hy],
        [edge, ty + 6],
      ],
      0.85,
    );
  }
  lines.forEach((line, i) => {
    ops.text(left + pad, top + pad * 0.7 + size * 0.6 + i * size * 1.2, size, line, 'hand', 'left');
  });
}

function figureOps(ops: OpList, el: FigureElement, rng: Rng): void {
  const h = Math.max(20, el.size);
  // Directional poses face the middle of the board.
  const dir =
    el.pose === 'point_left' || ((el.pose === 'walk' || el.pose === 'hold') && el.x > BOARD_WIDTH * 0.58) ? -1 : 1;
  const shape = poseShape(el.pose);
  const P = (p: Pt): Pt => [el.x + p[0] * h * dir, el.y + p[1] * h];
  const amp = clamp(h / 180, 0.35, 1);
  const r = HEAD_R * h;
  const [hx, hy] = P(shape.head);
  const neck = P(shape.neck);

  ops.stroke(handEllipse(hx, hy, r, r * 0.98, rng, 0.3, 0.025));
  faceOps(ops, el.face, hx, hy, r, rng);
  accessoryOps(ops, el.accessory, hx, hy, r, neck, h, rng);
  ops.stroke(handLine(neck, P(shape.hip), rng, amp));
  for (const limb of shape.limbs) ops.stroke(handPolyline(limb.map(P), rng, amp));
  for (const prop of shape.props) ops.stroke(handPolyline(prop.map(P), rng, amp * 0.6), 0.85);

  if (el.face === 'confused' && !el.say) {
    ops.text(hx + 1.7 * r * dir, hy - 1.2 * r, Math.max(14, 1.4 * r), '?', 'hand', 'center');
  }
  if (el.label) {
    const size = clamp(h * 0.12, 14, 22);
    const below = el.y + 6 + size * 0.6;
    if (below + size * 0.6 <= BOARD_HEIGHT - 2) {
      ops.text(el.x, below, size, el.label, 'hand', 'center');
    } else {
      // Feet on the bottom edge: write the name beside the legs (right unless that overflows).
      const width = estimateTextWidth(el.label, size);
      const offset = 0.26 * h + 6 + width / 2;
      const side = el.x + offset + width / 2 <= BOARD_WIDTH - TEXT_MARGIN ? 1 : -1;
      const x = el.x + side * offset;
      ops.text(x, el.y - 0.12 * h, size, el.label, 'hand', 'center');
    }
  }
  if (el.say) speechBubbleOps(ops, el.say, hx, hy, r, h, rng);
}

// ---------------------------------------------------------------- other kinds

function textBlockOps(ops: OpList, x: number, y: number, size: number, text: string): void {
  const lines = text.split('\n');
  const gap = size * 1.2;
  const widest = Math.max(0, ...lines.map((l) => estimateTextWidth(l.trimEnd(), size)));
  const left = fitAnchorX(x, widest, 'left');
  const top = clamp(y, 4, Math.max(4, BOARD_HEIGHT - 4 - lines.length * gap));
  lines.forEach((line, i) => ops.text(left, top + i * gap + size * 0.6, size, line, 'hand', 'left'));
}

function codeOps(ops: OpList, el: CodeElement, rng: Rng): void {
  const size = el.size;
  const lines = el.text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const gap = size * 1.3;
  const pad = size * 0.55;
  const widest = Math.max(size, ...lines.map((l) => estimateTextWidth(l, size, 'mono')));
  const maxLeft = BOARD_WIDTH - TEXT_MARGIN - pad - widest;
  const left = clamp(el.x, TEXT_MARGIN + pad, Math.max(TEXT_MARGIN + pad, maxLeft));
  const blockH = lines.length * gap;
  const top = clamp(el.y, 4 + pad * 0.6, Math.max(4 + pad * 0.6, BOARD_HEIGHT - 4 - pad * 0.6 - blockH));
  const x0 = left - pad;
  const x1 = left + widest + pad;
  const y0 = top - pad * 0.6;
  const y1 = top + blockH + pad * 0.6;
  const serif = Math.min(14, (x1 - x0) * 0.08 + 6);

  ops.stroke(
    handPolyline(
      [
        [x0 + serif, y0],
        [x0, y0],
        [x0, y1],
        [x0 + serif, y1],
      ],
      rng,
      0.4,
    ),
    0.8,
    0.7,
  );
  lines.forEach((line, i) => ops.text(left, top + i * gap + gap / 2, size, line, 'mono', 'left'));
  ops.stroke(
    handPolyline(
      [
        [x1 - serif, y0],
        [x1, y0],
        [x1, y1],
        [x1 - serif, y1],
      ],
      rng,
      0.4,
    ),
    0.8,
    0.7,
  );
}

function boxOps(ops: OpList, el: BoxElement, rng: Rng): void {
  const j = () => (rng() - 0.5) * 3;
  const tl: Pt = [el.x + j(), el.y + j()];
  const tr: Pt = [el.x + el.w + j(), el.y + j()];
  const br: Pt = [el.x + el.w + j(), el.y + el.h + j()];
  const bl: Pt = [el.x + j(), el.y + el.h + j()];
  const back: Pt = [el.x + j(), el.y + j()];
  const over: Pt = [back[0] + Math.min(10, el.w * 0.08), back[1] + j() * 0.4];
  ops.stroke(handPolyline([tl, tr, br, bl, back, over], rng));
  if (el.label) ops.label(el.label, el.x + el.w / 2, el.y + el.h / 2, el.w - 16, el.h - 10, 26);
}

function circleOps(ops: OpList, el: CircleElement, rng: Rng): void {
  const r = Math.max(2, el.r);
  ops.stroke(handEllipse(el.x, el.y, r, r * (0.95 + rng() * 0.08), rng, 0.4, 0.025));
  if (el.label) ops.label(el.label, el.x, el.y, r * 1.5, r * 1.1, 26);
}

function arrowOps(ops: OpList, el: ArrowElement, rng: Rng): void {
  const a: Pt = [el.x, el.y];
  const b: Pt = [el.x2, el.y2];
  const len = dist(a, b);
  if (len < 1) {
    ops.stroke([a, b]);
    return;
  }
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const curve = clamp(el.curve, -1, 1);
  const bend = curve * len * 0.5;
  const c: Pt = [(a[0] + b[0]) / 2 + nx * bend, (a[1] + b[1]) / 2 + ny * bend];

  if (Math.abs(curve) < 0.02) {
    ops.stroke(handLine(a, b, rng));
  } else {
    const n = Math.max(8, Math.ceil(len / 14));
    const ph = rng() * Math.PI * 2;
    const wob = Math.min(1.4, 0.3 + len * 0.006);
    const shaft: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = quadAt(a, c, b, t);
      const off = wob * Math.sin(Math.PI * 3 * t + ph) * Math.sin(Math.PI * t);
      shaft.push([p[0] + nx * off, p[1] + ny * off]);
    }
    ops.stroke(shaft);
  }

  // Two-stroke head along the final tangent.
  const from = Math.abs(curve) < 0.02 ? a : c;
  const tl = Math.max(1e-6, dist(from, b));
  const dx = (b[0] - from[0]) / tl;
  const dy = (b[1] - from[1]) / tl;
  const head = clamp(len * 0.2, 9, 22);
  const ang = 0.46 + (rng() - 0.5) * 0.08;
  for (const s of [1, -1]) {
    const ca = Math.cos(s * ang);
    const sa = Math.sin(s * ang);
    const barb: Pt = [b[0] - head * (dx * ca - dy * sa), b[1] - head * (dx * sa + dy * ca)];
    ops.stroke(handLine(barb, b, rng, 0.4));
  }

  if (el.label) {
    const { lines, size } = fitLabel(el.label, 320, 56, 20);
    const lw = Math.max(0, ...lines.map((l) => estimateTextWidth(l, size)));
    const lh = lines.length * size * 1.15;
    let sx = nx;
    let sy = ny;
    if (Math.abs(curve) >= 0.02) {
      // The shaft bulges toward sign(curve)·n; the label sits outside the bulge.
      if (curve < 0) {
        sx = -sx;
        sy = -sy;
      }
    } else if (Math.abs(sy) > 0.25 ? sy > 0 : sx < 0) {
      // Straight: above the shaft, or to the right of a vertical one.
      sx = -sx;
      sy = -sy;
    }
    const mid = quadAt(a, c, b, 0.5);
    const off = Math.abs(sy) * (lh / 2 + 8) + Math.abs(sx) * (lw / 2 + 10);
    const cx = clamp(mid[0] + sx * off, lw / 2 + TEXT_MARGIN, BOARD_WIDTH - lw / 2 - TEXT_MARGIN);
    const cy = clamp(mid[1] + sy * off, lh / 2 + 4, BOARD_HEIGHT - lh / 2 - 4);
    ops.label(el.label, cx, cy, 320, 56, 20);
  }
}

/** Ordered paint ops for one element. `seed` fixes its hand-drawn wobble. */
export function elementOps(el: ChalkElement, seed: number): PaintOp[] {
  const rng = mulberry32(seed);
  const ops = new OpList(el.color);
  switch (el.kind) {
    case 'figure':
      figureOps(ops, el, rng);
      break;
    case 'text':
      textBlockOps(ops, el.x, el.y, el.size, el.text);
      break;
    case 'code':
      codeOps(ops, el, rng);
      break;
    case 'box':
      boxOps(ops, el, rng);
      break;
    case 'circle':
      circleOps(ops, el, rng);
      break;
    case 'line':
      ops.stroke(handLine([el.x, el.y], [el.x2, el.y2], rng));
      break;
    case 'arrow':
      arrowOps(ops, el, rng);
      break;
    case 'path':
      ops.stroke(smoothPath(el.points, el.closed && el.points.length >= 3));
      break;
    case 'check': {
      const s = el.size;
      ops.stroke(
        handPolyline(
          [
            [el.x - 0.5 * s, el.y - 0.02 * s],
            [el.x - 0.15 * s, el.y + 0.33 * s],
            [el.x + 0.5 * s, el.y - 0.4 * s],
          ],
          rng,
          0.6,
        ),
        1.3,
      );
      break;
    }
    case 'cross': {
      const s = el.size * 0.4;
      ops.stroke(handLine([el.x - s, el.y - s], [el.x + s, el.y + s], rng, 0.6), 1.3);
      ops.stroke(handLine([el.x + s, el.y - s], [el.x - s, el.y + s], rng, 0.6), 1.3);
      break;
    }
  }
  return ops.list;
}

/** Geometry for every element of a scene drawing, seeded by scene + index. */
export function buildSceneGeometry(drawing: ChalkSceneDrawing, scene: number): ElementGeometry[] {
  return drawing.elements.map((el, i) => {
    const ops = elementOps(el, chalkSeed(scene, i));
    return { beat: el.beat, color: el.color, ops, ink: opsInk(ops) };
  });
}

// ---------------------------------------------------------------- heading + notes

/** The scene heading, centered in the top band with a yellow underline. */
export function headingOps(heading: string, scene: number): PaintOp[] {
  const text = heading.trim();
  if (!text) return [];
  const rng = mulberry32(chalkSeed(scene, 10007));
  const size = clamp(900 / (Array.from(text).length * HAND_ADVANCE), 20, 36);
  const width = Math.min(BOARD_WIDTH - 2 * TEXT_MARGIN, estimateTextWidth(text, size));
  const ops = new OpList('white');
  ops.text(BOARD_WIDTH / 2, HEADING_Y, size, text, 'hand', 'center');
  ops.color = 'yellow';
  const y = HEADING_Y + size * 0.5 + 8;
  ops.stroke(
    handLine(
      [BOARD_WIDTH / 2 - width / 2 - 4, y + (rng() - 0.5) * 2],
      [BOARD_WIDTH / 2 + width / 2 + 8, y - 1 + (rng() - 0.5) * 2],
      rng,
      0.8,
    ),
    0.9,
    0.85,
  );
  return ops.list;
}

/** Where fallback note `index` of `count` sits (y is the row's middle). */
export function noteLayout(index: number, count: number): { x: number; y: number; maxWidth: number } {
  const twoColumns = count > NOTE_ROWS;
  const rowsPerColumn = count > 2 * NOTE_ROWS ? Math.ceil(count / 2) : NOTE_ROWS;
  const rowHeight = rowsPerColumn > NOTE_ROWS ? (NOTE_BOTTOM - NOTE_TOP) / (rowsPerColumn - 1) : NOTE_ROW;
  const column = twoColumns ? Math.floor(index / rowsPerColumn) : 0;
  const row = twoColumns ? index % rowsPerColumn : index;
  return {
    x: column === 0 ? NOTE_X : NOTE_COLUMN_X,
    y: Math.min(NOTE_TOP + row * rowHeight, BOARD_HEIGHT - 24),
    maxWidth: twoColumns ? NOTE_COLUMN_X - NOTE_X - 20 : BOARD_WIDTH - NOTE_X - 60,
  };
}

/** "• note" as a yellow bullet plus white chalk text. */
export function noteOps(note: string, index: number, count: number): PaintOp[] {
  const text = note.trim().replace(/\s+/g, ' ');
  if (!text) return [];
  const { x, y, maxWidth } = noteLayout(index, count);
  const size = clamp(maxWidth / ((Array.from(text).length + 2) * HAND_ADVANCE), 15, NOTE_SIZE);
  const ops = new OpList('yellow');
  ops.text(x, y, size, '•', 'hand', 'left');
  ops.color = 'white';
  ops.text(x + size * 0.9, y, size, text, 'hand', 'left');
  return ops.list;
}

export function buildSceneChrome(scene: ChalkScene, index: number): SceneChrome {
  const count = scene.beats.length;
  const notes = scene.beats.map((beat, i) => noteOps(beat.note, i, count));
  return {
    heading: headingOps(scene.heading, index),
    notes,
    noteInks: notes.map(opsInk),
  };
}
