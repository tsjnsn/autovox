import {
  buildSceneChrome,
  buildSceneGeometry,
  type ElementGeometry,
  type SceneChrome,
} from './geometry';
import {
  BOARD_EDGE_COLOR,
  createChalkStyles,
  getBoardTexture,
  paintFrame,
  type BoardLayer,
  type ChalkStyles,
} from './paint';
import {
  frameAt,
  sceneReveal,
  type ArrivalInfo,
  type BoardFrame,
  type RevealItem,
} from './timeline';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  flattenBeats,
  type ChalkBeatRef,
  type ChalkLesson,
  type ChalkSceneDrawing,
  type ChalkTimeline,
} from './types';

export interface BoardProps {
  lesson: ChalkLesson;
  /** Indexed by scene; null until that scene's drawing arrives from the AI drawer (arrives asynchronously, in parallel with narration). */
  drawings: (ChalkSceneDrawing | null)[];
  /** Indexed by flattenBeats(lesson) order. Grows as narration audio downloads. */
  timeline: ChalkTimeline;
  /** Current media time in seconds (audio playhead, also reflects scrubbing/pausing/seeking). Poll it every animation frame; it is a stable function. */
  getTime: () => number;
}

export interface BoardRendererOptions {
  /** Backing-store pixels per CSS pixel; defaults to the display's devicePixelRatio. */
  pixelRatio?: number;
}

interface SceneArt {
  drawing: ChalkSceneDrawing;
  elements: ElementGeometry[];
  items: RevealItem[];
}

interface Viewport {
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  letterbox: boolean;
}

const EMPTY_CHROME: SceneChrome = { heading: [], notes: [], noteInks: [] };

/** A drawing with nothing in it is treated as missing, so notes keep the board alive. */
function usableDrawing(drawing: ChalkSceneDrawing | null | undefined): ChalkSceneDrawing | null {
  return drawing && drawing.elements.length > 0 ? drawing : null;
}

/** Owns the canvas, caches, and late-art bookkeeping for one board. */
export class BoardRenderer {
  reducedMotion = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly pixelRatio: number | undefined;
  private styles: ChalkStyles | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private lesson: ChalkLesson | null = null;
  private beats: ChalkBeatRef[] = [];
  private firstFlat = new Map<number, number>();
  private chrome = new Map<number, SceneChrome>();
  private art = new Map<number, SceneArt>();
  /** Scenes whose drawing has already been seen (arrivals are null → drawing flips). */
  private seen = new Set<number>();
  private primed = false;
  /** Scene → media time its art arrived while that scene was on the board. */
  private arrivals = new Map<number, number>();
  private version = 0;
  private lastKey = '';

  constructor(canvas: HTMLCanvasElement, options: BoardRendererOptions = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pixelRatio = options.pixelRatio;
  }

  setCssSize(width: number, height: number): void {
    this.cssWidth = width;
    this.cssHeight = height;
  }

  render(props: BoardProps): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const view = this.syncBackingStore();
    if (!view) return;
    if (props.lesson !== this.lesson) this.loadLesson(props.lesson);

    const raw = props.getTime();
    const t = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    const frame = frameAt(t, this.beats, props.timeline);
    this.trackArrivals(props.drawings, frame);

    const chrome = this.chromeFor(frame.scene);
    const art = this.artFor(frame.scene, props.drawings[frame.scene]);
    const reveal = sceneReveal({
      frame,
      heading: props.lesson.scenes[frame.scene]?.heading ?? '',
      noteInks: chrome.noteInks,
      elements: art?.items ?? null,
      arrival: this.arrivalFor(frame, props.timeline),
      reducedMotion: this.reducedMotion,
    });
    const prevScene = frame.prevScene !== null && reveal.wipe < 1 ? frame.prevScene : null;
    const prevArt = prevScene !== null ? this.artFor(prevScene, props.drawings[prevScene]) : null;

    // Repaint only when something visible changed.
    let key = `${this.canvas.width}x${this.canvas.height}|${this.version}|${this.reducedMotion ? 1 : 0}|${frame.scene}|${prevScene ?? -1}|${art ? 1 : 0}|${prevArt ? 1 : 0}`;
    for (const v of [reveal.wipe, reveal.heading, reveal.notesErase, ...reveal.notes, ...reveal.elements]) {
      key += `,${Math.round(v * 1e4)}`;
    }
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.styles ??= createChalkStyles(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (view.letterbox) {
      ctx.fillStyle = BOARD_EDGE_COLOR;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.setTransform(view.sx, 0, 0, view.sy, view.ox, view.oy);
    paintFrame(ctx, {
      texture: getBoardTexture(),
      styles: this.styles,
      current: this.layer(frame.scene, chrome, art),
      previous: prevScene !== null ? this.layer(prevScene, this.chromeFor(prevScene), prevArt) : null,
      reveal,
      showPen: !this.reducedMotion,
    });
  }

  /** Sizes the backing store to CSS size × pixel ratio; returns the board transform. */
  private syncBackingStore(): Viewport | null {
    const dpr = this.pixelRatio ?? (window.devicePixelRatio || 1);
    const w = Math.round(this.cssWidth * dpr);
    const h = Math.round(this.cssHeight * dpr);
    if (w < 2 || h < 2) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.lastKey = '';
    }
    const sx = w / BOARD_WIDTH;
    const sy = h / BOARD_HEIGHT;
    // A hair off 5:3 (borders, rounding) stretches invisibly; beyond that, letterbox.
    if (Math.abs(sx / sy - 1) <= 0.03) return { sx, sy, ox: 0, oy: 0, letterbox: false };
    const s = Math.min(sx, sy);
    return { sx: s, sy: s, ox: (w - s * BOARD_WIDTH) / 2, oy: (h - s * BOARD_HEIGHT) / 2, letterbox: true };
  }

  private loadLesson(lesson: ChalkLesson): void {
    this.lesson = lesson;
    this.beats = flattenBeats(lesson);
    this.firstFlat.clear();
    this.beats.forEach((b, i) => {
      if (!this.firstFlat.has(b.scene)) this.firstFlat.set(b.scene, i);
    });
    this.chrome.clear();
    this.art.clear();
    this.seen.clear();
    this.arrivals.clear();
    this.primed = false;
    this.version++;
    this.lastKey = '';
  }

  /**
   * Records when a scene's art shows up while that scene is already on the
   * board, so the renderer can erase the notes and catch up. Seeking back to
   * before the arrival forgets it: from then on the art plays normally.
   */
  private trackArrivals(drawings: readonly (ChalkSceneDrawing | null)[], frame: BoardFrame): void {
    if (!this.primed) {
      drawings.forEach((d, i) => {
        if (usableDrawing(d)) this.seen.add(i);
      });
      this.primed = true;
      return;
    }
    drawings.forEach((d, i) => {
      if (!usableDrawing(d)) {
        this.seen.delete(i);
        return;
      }
      if (this.seen.has(i)) return;
      this.seen.add(i);
      if (frame.started && frame.scene === i && frame.t > frame.sceneStart) {
        this.arrivals.set(i, frame.t);
      }
    });
    for (const [scene, at] of this.arrivals) {
      if (frame.t < at) this.arrivals.delete(scene);
    }
  }

  private arrivalFor(frame: BoardFrame, timeline: ChalkTimeline): ArrivalInfo | null {
    const at = this.arrivals.get(frame.scene);
    if (at === undefined || frame.t < at) return null;
    const atFrame = frameAt(at, this.beats, timeline);
    return atFrame.scene === frame.scene ? { at, frame: atFrame } : null;
  }

  private chromeFor(scene: number): SceneChrome {
    const cached = this.chrome.get(scene);
    if (cached) return cached;
    const data = this.lesson?.scenes[scene];
    const chrome = data ? buildSceneChrome(data, scene) : EMPTY_CHROME;
    this.chrome.set(scene, chrome);
    return chrome;
  }

  private artFor(scene: number, drawing: ChalkSceneDrawing | null | undefined): SceneArt | null {
    const usable = usableDrawing(drawing);
    if (!usable) return null;
    const cached = this.art.get(scene);
    if (cached?.drawing === usable) return cached;
    const elements = buildSceneGeometry(usable, scene);
    const entry: SceneArt = {
      drawing: usable,
      elements,
      items: elements.map((e) => ({ beat: e.beat, ink: e.ink })),
    };
    this.art.set(scene, entry);
    this.version++;
    return entry;
  }

  private layer(scene: number, chrome: SceneChrome, art: SceneArt | null): BoardLayer {
    return {
      scene,
      hazy: (this.firstFlat.get(scene) ?? 0) > 0,
      heading: chrome.heading,
      notes: chrome.notes,
      elements: art?.elements ?? null,
    };
  }
}
