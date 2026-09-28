/**
 * Pure board choreography: maps a media time onto the lesson's beats and
 * decides how much of each heading, note, and element is drawn. Everything is
 * a function of `t` (plus the drawing-arrival time), so scrubbing in either
 * direction always lands on the same board.
 */
import type { ChalkBeatRef, ChalkTimeline } from './types';

/** Eraser sweep over the previous scene's board. */
export const WIPE_SECONDS = 0.45;
/** Drawing speed for scene art, in board units of ink per second. */
export const INK_PER_SECOND = 900;
/** Fallback notes are written a little slower than art is sketched. */
export const NOTE_INK_PER_SECOND = 380;
export const MIN_DRAW_SECONDS = 0.5;
/** A beat's drawing never takes more than this share of its remaining time. */
export const DRAW_SHARE = 0.75;
/** Late-arriving art: erase the fallback notes, then catch up on missed elements. */
export const CATCHUP_ERASE_SECONDS = 0.35;
export const CATCHUP_DRAW_SECONDS = 1.2;

export interface BoardFrame {
  /** Media time this frame describes. */
  t: number;
  /** False until some beat's start is known and ≤ t. */
  started: boolean;
  /** Flattened beat index. */
  flat: number;
  scene: number;
  /** Scene shown before this one (whose board gets erased), if any. */
  prevScene: number | null;
  sceneStart: number;
  /** Beat index within the scene. */
  beat: number;
  beatStart: number;
  beatEnd: number;
  beatProgress: number;
}

export interface SceneTiming {
  wipeEnd: number;
  headingStart: number;
  headingEnd: number;
}

export interface RevealItem {
  /** Beat within the scene. */
  beat: number;
  ink: number;
}

export interface ArrivalInfo {
  /** Media time at which the drawing arrived while its scene was on the board. */
  at: number;
  /** frameAt(at): the board as it stood when the art arrived. */
  frame: BoardFrame;
}

export interface SceneRevealInput {
  frame: BoardFrame;
  heading: string;
  /** Ink of each beat's fallback note; its length is the scene's beat count. */
  noteInks: readonly number[];
  /** Beat + ink per drawn element (drawing order), or null while art is missing. */
  elements: readonly RevealItem[] | null;
  arrival?: ArrivalInfo | null;
  reducedMotion?: boolean;
}

export interface SceneReveal {
  /** Eraser sweep over the previous board, 0..1; 1 when done or nothing to erase. */
  wipe: number;
  heading: number;
  /** Fallback note reveal per beat (all 0 once art is on the board). */
  notes: number[];
  /** Eraser sweep over the fallback notes during catch-up; 0 when not erasing. */
  notesErase: number;
  /** Reveal per element, same order as `elements`. */
  elements: number[];
}

interface Slot {
  start: number;
  duration: number;
}

const PAST: Slot = { start: -Infinity, duration: 0 };
const FUTURE: Slot = { start: Infinity, duration: 0 };

function known(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function progress(t: number, start: number, duration: number, reduced: boolean): number {
  if (t < start) return 0;
  if (reduced || !(duration > 0)) return 1;
  return Math.min(1, (t - start) / duration);
}

export function estimateBeatSeconds(say: string): number {
  const words = say.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.5, words / 2.6);
}

/** 0.8–1.2 s depending on length (0 for an empty heading). */
export function headingSeconds(heading: string): number {
  const chars = Array.from(heading.trim()).length;
  if (chars === 0) return 0;
  return Math.min(1.2, 0.8 + (0.4 * Math.min(chars, 32)) / 32);
}

/**
 * Where `t` falls in the lesson. The current beat is the last flattened beat
 * whose start is known and ≤ t; before any, it is scene 0 / beat 0 at 0.
 */
export function frameAt(t: number, beats: readonly ChalkBeatRef[], timeline: ChalkTimeline): BoardFrame {
  const time = Number.isFinite(t) ? t : 0;
  let cur = -1;
  for (let i = 0; i < beats.length; i++) {
    const s = known(timeline.starts[i]);
    if (s !== null && s <= time) cur = i;
  }
  const ref = beats[cur];
  if (!ref) {
    const first = beats[0];
    const s0 = known(timeline.starts[0]) ?? 0;
    return {
      t: time,
      started: false,
      flat: 0,
      scene: first?.scene ?? 0,
      prevScene: null,
      sceneStart: s0,
      beat: 0,
      beatStart: s0,
      beatEnd: s0 + estimateBeatSeconds(first?.say ?? ''),
      beatProgress: 0,
    };
  }

  const beatStart = known(timeline.starts[cur]) ?? time;
  let beatEnd =
    known(timeline.ends[cur]) ?? known(timeline.starts[cur + 1]) ?? beatStart + estimateBeatSeconds(ref.say);
  if (!(beatEnd > beatStart)) beatEnd = beatStart + 0.05;

  const firstFlat = Math.max(0, cur - ref.beat);
  let sceneStart = beatStart;
  for (let i = firstFlat; i < cur; i++) {
    const s = known(timeline.starts[i]);
    if (s !== null && s <= beatStart) {
      sceneStart = s;
      break;
    }
  }

  return {
    t: time,
    started: true,
    flat: cur,
    scene: ref.scene,
    prevScene: firstFlat > 0 ? (beats[firstFlat - 1]?.scene ?? null) : null,
    sceneStart,
    beat: ref.beat,
    beatStart,
    beatEnd,
    beatProgress: clamp01((time - beatStart) / (beatEnd - beatStart)),
  };
}

/** Wipe (scenes after the first), then the heading, then beat 0's drawing. */
export function sceneTiming(frame: BoardFrame, heading: string, reducedMotion = false): SceneTiming {
  const wipe = frame.prevScene !== null && !reducedMotion ? WIPE_SECONDS : 0;
  const headingStart = frame.sceneStart + wipe;
  return {
    wipeEnd: headingStart,
    headingStart,
    headingEnd: headingStart + headingSeconds(heading),
  };
}

/**
 * The current beat's drawing window: starts at the beat (never before the
 * heading is written) and lasts clamp(ink / rate, 0.5 s, 0.75 × what's left).
 */
export function beatWindow(frame: BoardFrame, timing: SceneTiming, ink: number, inkPerSecond: number): Slot {
  const start = Math.max(frame.beatStart, timing.headingEnd);
  const cap = Math.max(MIN_DRAW_SECONDS, DRAW_SHARE * (frame.beatEnd - start));
  const duration = Math.min(cap, Math.max(MIN_DRAW_SECONDS, Math.max(0, ink) / inkPerSecond));
  return { start, duration };
}

function clampBeat(beat: number, beatCount: number): number {
  if (!Number.isFinite(beat)) return 0;
  return Math.min(Math.max(0, beatCount - 1), Math.max(0, Math.floor(beat)));
}

/** Normal schedule: earlier beats done, later beats pending, current beat by ink share. */
function elementSlots(
  frame: BoardFrame,
  timing: SceneTiming,
  items: readonly RevealItem[],
  beatCount: number,
): Slot[] {
  let total = 0;
  for (const it of items) {
    if (clampBeat(it.beat, beatCount) === frame.beat) total += Math.max(0, it.ink);
  }
  const win = beatWindow(frame, timing, total, INK_PER_SECOND);
  let acc = 0;
  return items.map((it) => {
    const b = clampBeat(it.beat, beatCount);
    if (b < frame.beat) return PAST;
    if (b > frame.beat) return FUTURE;
    const ink = Math.max(0, it.ink);
    const slot =
      total > 0
        ? { start: win.start + (win.duration * acc) / total, duration: (win.duration * ink) / total }
        : { start: win.start, duration: 0 };
    acc += ink;
    return slot;
  });
}

function noteReveals(frame: BoardFrame, timing: SceneTiming, noteInks: readonly number[], reduced: boolean): number[] {
  return noteInks.map((ink, b) => {
    if (b < frame.beat) return 1;
    if (b > frame.beat) return 0;
    const win = beatWindow(frame, timing, ink, NOTE_INK_PER_SECOND);
    return progress(frame.t, win.start, win.duration, reduced);
  });
}

/**
 * How much of the current scene is on the board at `frame.t`: heading, fallback
 * notes (when art is missing), and each element's reveal fraction 0..1.
 */
export function sceneReveal(input: SceneRevealInput): SceneReveal {
  const { frame, heading, noteInks, elements } = input;
  const reduced = input.reducedMotion ?? false;
  const zeros = (n: number) => new Array<number>(n).fill(0);
  if (!frame.started) {
    return {
      wipe: 1,
      heading: 0,
      notes: zeros(noteInks.length),
      notesErase: 0,
      elements: zeros(elements?.length ?? 0),
    };
  }

  const t = frame.t;
  const timing = sceneTiming(frame, heading, reduced);
  const wipeSpan = timing.wipeEnd - frame.sceneStart;
  const wipe = wipeSpan > 0 ? clamp01((t - frame.sceneStart) / wipeSpan) : 1;
  const headingReveal = progress(t, timing.headingStart, timing.headingEnd - timing.headingStart, reduced);

  if (!elements) {
    return {
      wipe,
      heading: headingReveal,
      notes: noteReveals(frame, timing, noteInks, reduced),
      notesErase: 0,
      elements: [],
    };
  }

  const beatCount = noteInks.length;
  const reveals = elementSlots(frame, timing, elements, beatCount).map((s) =>
    progress(t, s.start, s.duration, reduced),
  );

  const arrival = input.arrival;
  if (!arrival || !arrival.frame.started || arrival.frame.scene !== frame.scene || t < arrival.at) {
    return { wipe, heading: headingReveal, notes: zeros(noteInks.length), notesErase: 0, elements: reveals };
  }

  // Catch-up: the board showed notes until `at`. Erase them, then quickly draw
  // everything whose normal window had already begun; the rest keeps its schedule.
  const at = arrival.at;
  const erase = reduced ? 0 : CATCHUP_ERASE_SECONDS;
  const drawStart = at + erase;
  const timingAt = sceneTiming(arrival.frame, heading, reduced);
  const slotsAt = elementSlots(arrival.frame, timingAt, elements, beatCount);
  const late = slotsAt.map((s) => s.start < drawStart);
  let lateInk = 0;
  elements.forEach((it, i) => {
    if (late[i]) lateInk += Math.max(0, it.ink);
  });
  const catchUp = reduced ? 0 : Math.min(CATCHUP_DRAW_SECONDS, Math.max(MIN_DRAW_SECONDS, lateInk / INK_PER_SECOND));
  let acc = 0;
  elements.forEach((it, i) => {
    if (!late[i]) return;
    const ink = Math.max(0, it.ink);
    const start = lateInk > 0 ? drawStart + (catchUp * acc) / lateInk : drawStart;
    const duration = lateInk > 0 ? (catchUp * ink) / lateInk : 0;
    acc += ink;
    reveals[i] = progress(t, start, duration, reduced);
  });

  const notesAt = noteReveals(arrival.frame, timingAt, noteInks, reduced);
  const erased = erase > 0 ? clamp01((t - at) / erase) : 1;
  const erasing = erased < 1 && notesAt.some((v) => v > 0);
  return {
    wipe,
    heading: headingReveal,
    notes: erasing ? notesAt : zeros(noteInks.length),
    notesErase: erasing ? erased : 0,
    elements: reveals,
  };
}
