/**
 * Canvas painting for the chalkboard. All coordinates are board units; the
 * caller sets a transform that maps the 1000×600 board onto the canvas.
 */
import {
  chalkSeed,
  mulberry32,
  revealSlices,
  truncatePolyline,
  type ElementGeometry,
  type PaintOp,
  type StrokeOp,
  type TextOp,
} from './geometry';
import type { SceneReveal } from './timeline';
import { BOARD_HEADING_BAND, BOARD_HEIGHT, BOARD_WIDTH, CHALK_COLORS, type ChalkColor } from './types';

export const BOARD_COLOR = '#1f2d27';
/** Letterbox fill; matches the vignetted board edge. */
export const BOARD_EDGE_COLOR = '#161f1b';

export const CHALK_HEX: Record<ChalkColor, string> = {
  white: '#F2F1EA',
  yellow: '#F4D35E',
  pink: '#F28FAD',
  blue: '#8EC9F2',
  green: '#9BE39B',
};

export const HAND_FONT = '"Chalkboard SE", "Chalkduster", "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
export const MONO_FONT = '"Courier New", ui-monospace, monospace';

const STROKE_WIDTH = 3.2;
const TEXT_EDGE = 8;
const TEXTURE_SCALE = 1.5;

export type ChalkStyles = Record<ChalkColor, string | CanvasPattern>;

export interface PenState {
  x: number;
  y: number;
  color: ChalkColor;
}

export interface EraseRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_BOARD: EraseRegion = { x: 0, y: 0, w: BOARD_WIDTH, h: BOARD_HEIGHT };
export const NOTES_REGION: EraseRegion = {
  x: 0,
  y: BOARD_HEADING_BAND + 8,
  w: BOARD_WIDTH,
  h: BOARD_HEIGHT - BOARD_HEADING_BAND - 8,
};

/** One scene's paintable content. */
export interface BoardLayer {
  scene: number;
  /** The scene started by erasing a previous board, so faint haze remains. */
  hazy: boolean;
  heading: readonly PaintOp[];
  notes: readonly (readonly PaintOp[])[];
  /** Null while the scene's art hasn't arrived. */
  elements: readonly ElementGeometry[] | null;
}

export interface FrameInput {
  texture: CanvasImageSource | null;
  styles: ChalkStyles | null;
  current: BoardLayer;
  /** The previous scene's finished board, while it is being wiped. */
  previous: BoardLayer | null;
  reveal: SceneReveal;
  showPen: boolean;
}

// ---------------------------------------------------------------- one-time resources

let boardTexture: HTMLCanvasElement | null | undefined;

/** Board background (slate, smudges, dust, vignette), rendered once per page. */
export function getBoardTexture(): HTMLCanvasElement | null {
  if (boardTexture !== undefined) return boardTexture;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(BOARD_WIDTH * TEXTURE_SCALE);
  canvas.height = Math.round(BOARD_HEIGHT * TEXTURE_SCALE);
  const g = canvas.getContext('2d');
  if (!g) {
    boardTexture = null;
    return null;
  }
  g.scale(TEXTURE_SCALE, TEXTURE_SCALE);
  g.fillStyle = BOARD_COLOR;
  g.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  const rng = mulberry32(0xc4a1c);

  // Broad tonal variation: lighter chalk-dust clouds and darker damp patches.
  for (let i = 0; i < 22; i++) {
    const x = rng() * BOARD_WIDTH;
    const y = rng() * BOARD_HEIGHT;
    const r = 90 + rng() * 240;
    const light = rng() < 0.7;
    const a = light ? 0.012 + rng() * 0.026 : 0.04 + rng() * 0.05;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, light ? `rgba(235,240,232,${a})` : `rgba(0,0,0,${a})`);
    grad.addColorStop(1, light ? 'rgba(235,240,232,0)' : 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Old eraser swirls.
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < 12; i++) {
    const cx = rng() * BOARD_WIDTH;
    const cy = rng() * BOARD_HEIGHT;
    const len = 160 + rng() * 320;
    const tilt = (rng() - 0.5) * 0.5;
    g.lineWidth = 36 + rng() * 50;
    g.strokeStyle = `rgba(230,236,228,${0.012 + rng() * 0.016})`;
    g.beginPath();
    for (let k = 0; k <= 8; k++) {
      const s = k / 8 - 0.5;
      const x = cx + s * len * Math.cos(tilt);
      const y = cy + s * len * Math.sin(tilt) + Math.sin(s * 6 + i) * 10;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  // Fine dust.
  for (let i = 0; i < 4200; i++) {
    const light = rng() < 0.75;
    g.fillStyle = light ? `rgba(240,242,236,${0.02 + rng() * 0.06})` : `rgba(0,0,0,${0.05 + rng() * 0.08})`;
    const s = 0.5 + rng() * 1.2;
    g.fillRect(rng() * BOARD_WIDTH, rng() * BOARD_HEIGHT, s, s);
  }

  // Soft vignette.
  const v = g.createRadialGradient(
    BOARD_WIDTH / 2,
    BOARD_HEIGHT / 2,
    BOARD_HEIGHT * 0.35,
    BOARD_WIDTH / 2,
    BOARD_HEIGHT / 2,
    BOARD_WIDTH * 0.64,
  );
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.4)');
  g.fillStyle = v;
  g.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

  boardTexture = canvas;
  return canvas;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Speckled chalk fills: mostly solid pigment with ~10% dusty gaps. */
export function createChalkStyles(ctx: CanvasRenderingContext2D): ChalkStyles {
  const styles: ChalkStyles = { ...CHALK_HEX };
  CHALK_COLORS.forEach((color, ci) => {
    const size = 64;
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const g = tile.getContext('2d');
    if (!g) return;
    const img = g.createImageData(size, size);
    const [r, gr, b] = hexRgb(CHALK_HEX[color]);
    const rng = mulberry32(0x5eed + ci * 977);
    for (let i = 0; i < size * size; i++) {
      const gap = rng() < 0.1;
      const a = gap ? 0.2 + rng() * 0.25 : 0.78 + rng() * 0.22;
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = gr;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (pattern) styles[color] = pattern;
  });
  return styles;
}

// ---------------------------------------------------------------- background

export function paintBackground(ctx: CanvasRenderingContext2D, texture: CanvasImageSource | null): void {
  if (texture) {
    ctx.drawImage(texture, 0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  } else {
    ctx.fillStyle = BOARD_COLOR;
    ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  }
}

/** Faint horizontal smears left behind by the eraser. */
export function paintHaze(ctx: CanvasRenderingContext2D, scene: number): void {
  const rng = mulberry32(chalkSeed(scene, 9001));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 5; i++) {
    const y = 110 + i * 100 + (rng() - 0.5) * 40;
    ctx.lineWidth = 60 + rng() * 40;
    ctx.strokeStyle = `rgba(230,236,230,${0.016 + rng() * 0.014})`;
    ctx.beginPath();
    for (let x = 20, k = 0; x <= BOARD_WIDTH - 20; x += 120, k++) {
      const yy = y + (k % 2 === 0 ? -1 : 1) * (6 + rng() * 10);
      if (k === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Eraser sweep over `region`, left → right. Everything left of the band is
 * restored to the clean board by `restore`; the band itself is a half-erased
 * smear with dusty streaks.
 */
export function paintEraser(
  ctx: CanvasRenderingContext2D,
  progress: number,
  region: EraseRegion,
  seed: number,
  restore: () => void,
): void {
  const p = Math.min(1, Math.max(0, progress));
  const band = Math.min(130, region.w * 0.16);
  const cx = region.x - band / 2 + p * (region.w + band);
  const erasedW = Math.max(0, Math.min(region.w, cx - region.x));

  if (erasedW > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(region.x, region.y, erasedW, region.h);
    ctx.clip();
    ctx.globalAlpha = 1;
    restore();
    ctx.restore();
  }

  // Leading half of the band: partly wiped.
  const leadX = Math.max(region.x, cx);
  const leadW = Math.min(region.x + region.w, cx + band / 2) - leadX;
  if (leadW > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(leadX, region.y, leadW, region.h);
    ctx.clip();
    ctx.globalAlpha = 0.6;
    restore();
    ctx.restore();
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(region.x, region.y, region.w, region.h);
  ctx.clip();
  const grad = ctx.createLinearGradient(cx - band / 2, 0, cx + band / 2, 0);
  grad.addColorStop(0, 'rgba(226,232,226,0)');
  grad.addColorStop(0.5, 'rgba(226,232,226,0.08)');
  grad.addColorStop(0.72, 'rgba(226,232,226,0.13)');
  grad.addColorStop(1, 'rgba(226,232,226,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(cx - band / 2, region.y, band, region.h);

  const rng = mulberry32(seed);
  ctx.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const y = region.y + rng() * region.h;
    const len = band * (0.4 + rng() * 0.5);
    const x0 = cx - len * 0.75;
    ctx.lineWidth = 1.5 + rng() * 4;
    ctx.strokeStyle = `rgba(232,236,230,${0.05 + rng() * 0.06})`;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + len, y + (rng() - 0.5) * 6);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- chalk marks

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly [number, number][], dx: number, dy: number): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x + dx, y + dy);
    else ctx.lineTo(x + dx, y + dy);
  });
}

function paintStroke(
  ctx: CanvasRenderingContext2D,
  styles: ChalkStyles | null,
  op: StrokeOp,
  fraction: number,
): PenState | null {
  const pts = fraction >= 1 ? op.points : truncatePolyline(op.points, fraction);
  const last = pts[pts.length - 1];
  if (!last) return null;
  ctx.strokeStyle = styles?.[op.color] ?? CHALK_HEX[op.color];
  ctx.lineWidth = STROKE_WIDTH * op.weight;
  ctx.globalAlpha = 0.88 * op.alpha;
  tracePath(ctx, pts, 0, 0);
  ctx.stroke();
  // Thin offset pass for grain.
  ctx.strokeStyle = CHALK_HEX[op.color];
  ctx.lineWidth = 1.3 * op.weight;
  ctx.globalAlpha = 0.3 * op.alpha;
  tracePath(ctx, pts, 0.9, -0.7);
  ctx.stroke();
  ctx.globalAlpha = 1;
  return { x: last[0], y: last[1], color: op.color };
}

const textWidths = new WeakMap<TextOp, number>();

function paintText(
  ctx: CanvasRenderingContext2D,
  styles: ChalkStyles | null,
  op: TextOp,
  fraction: number,
): PenState {
  ctx.font = `${op.size}px ${op.font === 'mono' ? MONO_FONT : HAND_FONT}`;
  let full = textWidths.get(op);
  if (full === undefined) {
    full = ctx.measureText(op.text).width;
    textWidths.set(op, full);
  }
  // Squeeze text that can't fit; shift anything that would overflow the edge.
  const avail = BOARD_WIDTH - 2 * TEXT_EDGE;
  const sx = full > avail ? avail / full : 1;
  const width = full * sx;
  let left = op.align === 'left' ? op.x : op.align === 'center' ? op.x - width / 2 : op.x - width;
  left = Math.min(Math.max(left, TEXT_EDGE), BOARD_WIDTH - TEXT_EDGE - width);

  const chars = Array.from(op.text);
  const n = fraction >= 1 ? chars.length : Math.floor(chars.length * fraction);
  const shown = n >= chars.length ? op.text : chars.slice(0, n).join('');
  let penX = left + width;
  if (shown) {
    ctx.save();
    ctx.translate(left, op.y);
    if (sx !== 1) ctx.scale(sx, 1);
    ctx.fillStyle = styles?.[op.color] ?? CHALK_HEX[op.color];
    ctx.globalAlpha = 0.92 * op.alpha;
    ctx.fillText(shown, 0, 0);
    ctx.fillStyle = CHALK_HEX[op.color];
    ctx.globalAlpha = 0.18 * op.alpha;
    ctx.fillText(shown, 0.8, 0.6);
    if (shown !== op.text) penX = left + ctx.measureText(shown).width * sx;
    ctx.restore();
  } else {
    penX = left;
  }
  return { x: penX, y: op.y + op.size * 0.3, color: op.color };
}

function paintOp(ctx: CanvasRenderingContext2D, styles: ChalkStyles | null, op: PaintOp, fraction: number): PenState | null {
  return op.type === 'stroke' ? paintStroke(ctx, styles, op, fraction) : paintText(ctx, styles, op, fraction);
}

/**
 * Paints the prefix of `ops` covering `fraction` of their ink (partial last
 * stroke by arc length, partial text by characters). Returns where the chalk
 * is while drawing, or null when nothing or everything is drawn.
 */
export function paintOps(
  ctx: CanvasRenderingContext2D,
  styles: ChalkStyles | null,
  ops: readonly PaintOp[],
  fraction: number,
): PenState | null {
  if (!(fraction > 0)) return null;
  if (fraction >= 1) {
    for (const op of ops) paintOp(ctx, styles, op, 1);
    return null;
  }
  let pen: PenState | null = null;
  for (const slice of revealSlices(ops, fraction).slices) {
    pen = paintOp(ctx, styles, slice.op, slice.fraction) ?? pen;
  }
  return pen;
}

/** Chalk tip at the drawing position. */
export function paintPen(ctx: CanvasRenderingContext2D, pen: PenState): void {
  ctx.save();
  ctx.fillStyle = CHALK_HEX[pen.color];
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.arc(pen.x, pen.y, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(pen.x, pen.y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintLayerFinished(ctx: CanvasRenderingContext2D, styles: ChalkStyles | null, layer: BoardLayer): void {
  paintOps(ctx, styles, layer.heading, 1);
  if (layer.elements) {
    for (const el of layer.elements) paintOps(ctx, styles, el.ops, 1);
  } else {
    for (const note of layer.notes) paintOps(ctx, styles, note, 1);
  }
}

/** Paints one board frame (the caller has already set the board transform). */
export function paintFrame(ctx: CanvasRenderingContext2D, input: FrameInput): void {
  const { texture, styles, current, previous, reveal } = input;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  const cleanBoard = (layer: BoardLayer) => () => {
    paintBackground(ctx, texture);
    if (layer.hazy) paintHaze(ctx, layer.scene);
  };

  if (previous && reveal.wipe < 1) {
    cleanBoard(previous)();
    paintLayerFinished(ctx, styles, previous);
    paintEraser(ctx, reveal.wipe, FULL_BOARD, chalkSeed(current.scene, 4242), cleanBoard(current));
    ctx.restore();
    return;
  }

  cleanBoard(current)();
  let pen = paintOps(ctx, styles, current.heading, reveal.heading);
  current.notes.forEach((ops, i) => {
    pen = paintOps(ctx, styles, ops, reveal.notes[i] ?? 0) ?? pen;
  });
  if (reveal.notesErase > 0 && reveal.notesErase < 1) {
    paintEraser(ctx, reveal.notesErase, NOTES_REGION, chalkSeed(current.scene, 4343), cleanBoard(current));
    pen = null;
  }
  current.elements?.forEach((el, i) => {
    pen = paintOps(ctx, styles, el.ops, reveal.elements[i] ?? 0) ?? pen;
  });
  if (pen && input.showPen) paintPen(ctx, pen);
  ctx.restore();
}
