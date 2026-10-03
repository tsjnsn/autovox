import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSceneChrome,
  buildSceneGeometry,
  chalkSeed,
  elementOps,
  findReplacements,
  fitLabel,
  noteLayout,
  opsInk,
  polylineLength,
  revealedChars,
  revealSlices,
  truncatePolyline,
  wrapText,
  type PaintOp,
  type Pt,
} from "../utils/chalk/geometry";
import {
  beatWindow,
  CATCHUP_DRAW_SECONDS,
  CATCHUP_ERASE_SECONDS,
  estimateBeatSeconds,
  frameAt,
  headingSeconds,
  replaceReveal,
  sceneReveal,
  sceneTiming,
  WIPE_SECONDS,
  type ArrivalInfo,
  type RevealItem,
  type SceneReveal,
} from "../utils/chalk/timeline";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  CHALK_ACCESSORIES,
  CHALK_FACES,
  CHALK_POSES,
  flattenBeats,
  type ChalkElement,
  type ChalkLesson,
  type ChalkSceneDrawing,
  type ChalkTimeline,
} from "../utils/chalk/types";

const LESSON: ChalkLesson = {
  title: "Recursion",
  cast: [{ name: "Ada", accessory: "glasses", role: "the programmer" }],
  scenes: [
    {
      heading: "What is recursion?",
      visual: "Ada at a whiteboard",
      beats: [
        { say: "Recursion is when a function calls itself.", note: "Function calls itself" },
        { say: "Every recursive function needs a base case to stop.", note: "Base case stops it" },
      ],
    },
    {
      heading: "The call stack",
      visual: "Stack of boxes",
      beats: [
        { say: "Each call waits on the stack.", note: "Calls pile up" },
        { say: "Then they unwind one by one.", note: "Then unwind" },
      ],
    },
  ],
  estimatedSeconds: 17,
};

const BEATS = flattenBeats(LESSON);
const FULL_TIMELINE: ChalkTimeline = { starts: [0, 4, 9, 13], ends: [4, 9, 13, 17] };

const DRAWING: ChalkSceneDrawing = {
  elements: [
    {
      kind: "figure",
      beat: 0,
      color: "white",
      x: 200,
      y: 520,
      size: 220,
      pose: "point_right",
      face: "happy",
      accessory: "glasses",
      label: "Ada",
      say: "Watch this!",
    },
    { kind: "box", beat: 0, color: "yellow", x: 420, y: 200, w: 220, h: 90, label: "f(n)" },
    { kind: "arrow", beat: 1, color: "pink", x: 640, y: 245, x2: 800, y2: 360, curve: 0.4, label: "calls" },
    { kind: "text", beat: 1, color: "green", x: 700, y: 420, size: 28, text: "base case\nstops it" },
  ],
};

const SCENE0_CHROME = buildSceneChrome(LESSON.scenes[0]!, 0);
const SCENE0_GEOMETRY = buildSceneGeometry(DRAWING, 0);
const SCENE0_ITEMS: RevealItem[] = SCENE0_GEOMETRY.map((g) => ({ beat: g.beat, ink: g.ink }));

function reveal(
  t: number,
  opts: {
    timeline?: ChalkTimeline;
    elements?: RevealItem[] | null;
    arrival?: ArrivalInfo | null;
    reducedMotion?: boolean;
  } = {},
): SceneReveal {
  const timeline = opts.timeline ?? FULL_TIMELINE;
  const frame = frameAt(t, BEATS, timeline);
  const scene = LESSON.scenes[frame.scene]!;
  return sceneReveal({
    frame,
    heading: scene.heading,
    noteInks: buildSceneChrome(scene, frame.scene).noteInks,
    elements: opts.elements === undefined ? SCENE0_ITEMS : opts.elements,
    arrival: opts.arrival ?? null,
    reducedMotion: opts.reducedMotion ?? false,
  });
}

function assertFiniteOps(ops: PaintOp[], what: string): void {
  assert.ok(ops.length > 0, `${what}: no ops`);
  assert.ok(opsInk(ops) > 0, `${what}: no ink`);
  for (const op of ops) {
    assert.ok(Number.isFinite(op.ink) && op.ink > 0, `${what}: bad ink`);
    if (op.type === "stroke") {
      assert.ok(op.points.length >= 2, `${what}: short stroke`);
      for (const [x, y] of op.points) {
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `${what}: non-finite point`);
        assert.ok(x >= 0 && x <= BOARD_WIDTH && y >= 0 && y <= BOARD_HEIGHT, `${what}: point off board`);
      }
    } else {
      assert.ok(Number.isFinite(op.x) && Number.isFinite(op.y), `${what}: non-finite text anchor`);
      assert.ok(op.size > 0 && op.text.length > 0, `${what}: empty text`);
      assert.ok(op.y > 0 && op.y < BOARD_HEIGHT, `${what}: text off board`);
    }
  }
}

// ---------------------------------------------------------------- timing

void test("estimateBeatSeconds uses 2.6 words per second with a 1.5 s floor", () => {
  assert.equal(estimateBeatSeconds(""), 1.5);
  assert.equal(estimateBeatSeconds("one two"), 1.5);
  assert.equal(estimateBeatSeconds(Array.from({ length: 26 }, () => "word").join(" ")), 10);
  assert.equal(headingSeconds(""), 0);
  assert.equal(headingSeconds("Hi"), 0.8 + (0.4 * 2) / 32);
  assert.equal(headingSeconds("x".repeat(80)), 1.2);
});

void test("frameAt picks scene, beat and progress from known starts and ends", () => {
  const a = frameAt(5, BEATS, FULL_TIMELINE);
  assert.equal(a.started, true);
  assert.equal(a.flat, 1);
  assert.equal(a.scene, 0);
  assert.equal(a.beat, 1);
  assert.equal(a.sceneStart, 0);
  assert.equal(a.beatStart, 4);
  assert.equal(a.beatEnd, 9);
  assert.equal(a.beatProgress, 0.2);
  assert.equal(a.prevScene, null);

  const b = frameAt(10, BEATS, FULL_TIMELINE);
  assert.equal(b.flat, 2);
  assert.equal(b.scene, 1);
  assert.equal(b.beat, 0);
  assert.equal(b.sceneStart, 9);
  assert.equal(b.prevScene, 0);

  const c = frameAt(14, BEATS, FULL_TIMELINE);
  assert.equal(c.scene, 1);
  assert.equal(c.beat, 1);
  assert.equal(c.sceneStart, 9);

  assert.equal(frameAt(100, BEATS, FULL_TIMELINE).beatProgress, 1);
  // Exactly on a boundary belongs to the new beat.
  assert.equal(frameAt(4, BEATS, FULL_TIMELINE).flat, 1);
});

void test("frameAt falls back to the next start, then to the word estimate", () => {
  const timeline: ChalkTimeline = { starts: [0, 4, null, null], ends: [null, null, null, null] };
  const a = frameAt(2, BEATS, timeline);
  assert.equal(a.beatEnd, 4);
  assert.equal(a.beatProgress, 0.5);

  const b = frameAt(6, BEATS, timeline);
  assert.equal(b.flat, 1);
  assert.equal(b.beatEnd, 4 + estimateBeatSeconds(BEATS[1]!.say));
  assert.ok(b.beatProgress > 0 && b.beatProgress < 1);

  // Playhead far past everything known: holds the last known beat, fully done.
  assert.equal(frameAt(60, BEATS, timeline).flat, 1);
  assert.equal(frameAt(60, BEATS, timeline).beatProgress, 1);
});

void test("frameAt before the first start is scene 0 / beat 0 at zero progress", () => {
  const late: ChalkTimeline = { starts: [2, null, null, null], ends: [] };
  const a = frameAt(1, BEATS, late);
  assert.equal(a.started, false);
  assert.equal(a.scene, 0);
  assert.equal(a.beat, 0);
  assert.equal(a.beatProgress, 0);

  const empty = frameAt(3, BEATS, { starts: [], ends: [] });
  assert.equal(empty.started, false);
  assert.equal(empty.scene, 0);
  assert.equal(empty.beatProgress, 0);

  const r = reveal(1, { timeline: late });
  assert.equal(r.heading, 0);
  assert.deepEqual(r.elements, [0, 0, 0, 0]);
});

void test("frameAt is a pure function of t (seeking is deterministic)", () => {
  const forward = [0.5, 3, 7, 11, 15].map((t) => frameAt(t, BEATS, FULL_TIMELINE));
  const backward = [15, 11, 7, 3, 0.5].map((t) => frameAt(t, BEATS, FULL_TIMELINE)).reverse();
  assert.deepEqual(forward, backward);
  assert.deepEqual(reveal(6.2), reveal(6.2));
});

void test("drawing window is clamp(ink / rate, 0.5 s, 0.75 × remaining beat)", () => {
  const frame = frameAt(5, BEATS, FULL_TIMELINE);
  const timing = sceneTiming(frame, LESSON.scenes[0]!.heading);
  assert.deepEqual(beatWindow(frame, timing, 90, 900), { start: 4, duration: 0.5 });
  assert.deepEqual(beatWindow(frame, timing, 1800, 900), { start: 4, duration: 2 });
  assert.deepEqual(beatWindow(frame, timing, 90000, 900), { start: 4, duration: 3.75 });

  // Beat 0 waits for the heading; later scenes also wait for the wipe.
  const first = frameAt(0.1, BEATS, FULL_TIMELINE);
  assert.equal(beatWindow(first, sceneTiming(first, "What is recursion?"), 900, 900).start, headingSeconds("What is recursion?"));
  const second = frameAt(9.1, BEATS, FULL_TIMELINE);
  const t2 = sceneTiming(second, "The call stack");
  assert.equal(t2.headingStart, 9 + WIPE_SECONDS);
  assert.equal(beatWindow(second, t2, 900, 900).start, 9 + WIPE_SECONDS + headingSeconds("The call stack"));
});

// ---------------------------------------------------------------- reveal

void test("reveal fractions are monotonic in t and complete once windows pass", () => {
  let prev = reveal(0);
  for (let t = 0; t < 9; t += 0.01) {
    const r = reveal(t);
    assert.ok(r.heading >= prev.heading, `heading regressed at ${t}`);
    r.elements.forEach((v, i) => {
      assert.ok(v >= 0 && v <= 1);
      assert.ok(v >= (prev.elements[i] ?? 0) - 1e-12, `element ${i} regressed at ${t}`);
    });
    prev = r;
  }

  // During the heading nothing else is drawn.
  const early = reveal(0.3);
  assert.ok(early.heading > 0 && early.heading < 1);
  assert.deepEqual(early.elements, [0, 0, 0, 0]);
  assert.equal(early.wipe, 1);

  // Beat 0's art is done well before beat 1; beat 1's hasn't started.
  const endOfBeat0 = reveal(3.99);
  assert.equal(endOfBeat0.heading, 1);
  assert.deepEqual(endOfBeat0.elements, [1, 1, 0, 0]);

  // Elements are drawn one after another.
  const beat1Mid = reveal(4.2);
  assert.equal(beat1Mid.elements[0], 1);
  assert.ok(beat1Mid.elements[2]! > 0);
  assert.equal(beat1Mid.elements[3], 0);

  assert.deepEqual(reveal(8.9).elements, [1, 1, 1, 1]);
  assert.deepEqual(reveal(8.9).notes, [0, 0]);
});

void test("later scenes wipe the previous board before writing the heading", () => {
  const mid = reveal(9 + WIPE_SECONDS / 2, { elements: null });
  assert.ok(mid.wipe > 0.4 && mid.wipe < 0.6);
  assert.equal(mid.heading, 0);
  assert.deepEqual(mid.notes, [0, 0]);

  const after = reveal(9 + WIPE_SECONDS + 0.1, { elements: null });
  assert.equal(after.wipe, 1);
  assert.ok(after.heading > 0);

  const reduced = reveal(9.01, { elements: null, reducedMotion: true });
  assert.equal(reduced.wipe, 1);
  assert.equal(reduced.heading, 1);
});

void test("fallback notes are written beat by beat while art is missing", () => {
  const headingEnd = headingSeconds(LESSON.scenes[0]!.heading);
  assert.deepEqual(reveal(headingEnd - 0.05, { elements: null }).notes, [0, 0]);
  const writing = reveal(headingEnd + 0.3, { elements: null }).notes;
  assert.ok(writing[0]! > 0 && writing[0]! < 1);
  assert.equal(writing[1], 0);
  assert.deepEqual(reveal(3.9, { elements: null }).notes, [1, 0]);
  const beat1 = reveal(4.2, { elements: null }).notes;
  assert.equal(beat1[0], 1);
  assert.ok(beat1[1]! > 0);
  assert.deepEqual(reveal(8.5, { elements: null }).notes, [1, 1]);

  let prev = [0, 0];
  for (let t = 0; t < 9; t += 0.02) {
    const notes = reveal(t, { elements: null }).notes;
    notes.forEach((v, i) => assert.ok(v >= prev[i]! - 1e-12));
    prev = notes;
  }

  assert.deepEqual(noteLayout(0, 3), { x: 60, y: 120, maxWidth: 880 });
  assert.equal(noteLayout(1, 3).y, 172);
  assert.equal(noteLayout(2, 3).y, 224);
  // Overflow moves into a second column.
  assert.equal(noteLayout(8, 12).x, 60);
  assert.equal(noteLayout(9, 12).x, 520);
  assert.equal(noteLayout(9, 12).y, 120);
  for (let i = 0; i < 30; i++) {
    const { y } = noteLayout(i, 30);
    assert.ok(y >= 120 && y < BOARD_HEIGHT);
  }

  assert.equal(SCENE0_CHROME.notes.length, 2);
  SCENE0_CHROME.notes.forEach((ops, i) => assertFiniteOps(ops, `note ${i}`));
  assertFiniteOps(SCENE0_CHROME.heading, "heading");
});

void test("late art erases the notes, then catches up on missed elements", () => {
  const at = 5.5;
  const arrival: ArrivalInfo = { at, frame: frameAt(at, BEATS, FULL_TIMELINE) };

  // Before the arrival time (seeked back) the art plays normally.
  const before = reveal(at - 0.1, { arrival });
  assert.deepEqual(before.notes, [0, 0]);
  assert.equal(before.elements[0], 1);

  const erasing = reveal(at + CATCHUP_ERASE_SECONDS / 2, { arrival });
  assert.ok(erasing.notesErase > 0.4 && erasing.notesErase < 0.6);
  assert.equal(erasing.notes[0], 1);
  assert.ok(erasing.notes[1]! > 0);
  assert.deepEqual(erasing.elements, [0, 0, 0, 0]);

  const catching = reveal(at + CATCHUP_ERASE_SECONDS + 0.2, { arrival });
  assert.equal(catching.notesErase, 0);
  assert.deepEqual(catching.notes, [0, 0]);
  assert.ok(catching.elements[0]! > 0);

  const done = reveal(at + CATCHUP_ERASE_SECONDS + CATCHUP_DRAW_SECONDS + 0.01, { arrival });
  assert.deepEqual(done.elements, [1, 1, 1, 1]);

  let prev = reveal(at, { arrival });
  for (let t = at; t < 9; t += 0.01) {
    const r = reveal(t, { arrival });
    r.elements.forEach((v, i) => assert.ok(v >= prev.elements[i]! - 1e-12, `element ${i} regressed at ${t}`));
    prev = r;
  }

  // Arriving during the heading: nothing to erase, beat 0 keeps its schedule.
  const early: ArrivalInfo = { at: 0.3, frame: frameAt(0.3, BEATS, FULL_TIMELINE) };
  for (let t = 0.3; t < 4; t += 0.05) {
    const r = reveal(t, { arrival: early });
    assert.equal(r.notesErase, 0);
    assert.deepEqual(r.notes, [0, 0]);
    assert.deepEqual(r.elements, reveal(t).elements);
  }
});

void test("reduced motion shows whole elements at their start and skips the wipe", () => {
  const at = 5.5;
  const arrival: ArrivalInfo = { at, frame: frameAt(at, BEATS, FULL_TIMELINE) };
  for (let t = 0; t < 17; t += 0.05) {
    for (const r of [
      reveal(t, { reducedMotion: true }),
      reveal(t, { reducedMotion: true, elements: null }),
      reveal(t, { reducedMotion: true, arrival }),
    ]) {
      assert.equal(r.wipe, 1);
      assert.ok(r.heading === 0 || r.heading === 1);
      for (const v of [...r.elements, ...r.notes]) assert.ok(v === 0 || v === 1, `partial reveal at ${t}`);
      assert.equal(r.notesErase, 0);
    }
  }
  assert.deepEqual(reveal(at + 0.01, { reducedMotion: true, arrival }).elements, [1, 1, 1, 1]);
});

// ---------------------------------------------------------------- geometry

function base(kind: ChalkElement["kind"]): ChalkElement {
  switch (kind) {
    case "figure":
      return {
        kind,
        beat: 0,
        color: "white",
        x: 500,
        y: 500,
        size: 200,
        pose: "stand",
        face: "neutral",
        accessory: "none",
        label: null,
        say: null,
      };
    case "text":
      return { kind, beat: 0, color: "white", x: 100, y: 120, size: 30, text: "Hello\nworld" };
    case "code":
      return { kind, beat: 0, color: "blue", x: 100, y: 300, size: 20, text: "def f(n):\n  return f(n - 1)" };
    case "box":
      return { kind, beat: 0, color: "yellow", x: 300, y: 200, w: 200, h: 100, label: "A very long label for a box" };
    case "circle":
      return { kind, beat: 0, color: "pink", x: 700, y: 300, r: 60, label: "core" };
    case "line":
      return { kind, beat: 0, color: "white", x: 50, y: 550, x2: 950, y2: 550 };
    case "arrow":
      return { kind, beat: 0, color: "green", x: 100, y: 400, x2: 400, y2: 400, curve: 0, label: "next" };
    case "path":
      return {
        kind,
        beat: 0,
        color: "white",
        points: [
          [100, 500],
          [200, 420],
          [300, 480],
          [400, 400],
        ],
        closed: false,
      };
    case "check":
    case "cross":
      return { kind, beat: 0, color: "green", x: 900, y: 120, size: 40 };
  }
}

void test("every element kind yields finite, on-board ops with ink", () => {
  const kinds: ChalkElement["kind"][] = ["figure", "text", "code", "box", "circle", "line", "arrow", "path", "check", "cross"];
  kinds.forEach((kind, i) => assertFiniteOps(elementOps(base(kind), chalkSeed(0, i)), kind));

  // Variants: curved and vertical arrows, closed paths, edge-hugging text.
  const variants: ChalkElement[] = [
    { kind: "arrow", beat: 0, color: "white", x: 100, y: 100, x2: 900, y2: 500, curve: -1, label: "far" },
    { kind: "arrow", beat: 0, color: "white", x: 990, y: 100, x2: 990, y2: 590, curve: 0.7, label: "edge label" },
    { kind: "arrow", beat: 0, color: "white", x: 500, y: 90, x2: 500, y2: 400, curve: 0, label: null },
    { kind: "path", beat: 0, color: "white", points: [[10, 10], [990, 10], [500, 590]], closed: true },
    { kind: "path", beat: 0, color: "white", points: [[10, 10], [20, 20]], closed: false },
    { kind: "text", beat: 0, color: "white", x: 980, y: 590, size: 40, text: "overflowing text near the corner" },
    { kind: "code", beat: 0, color: "white", x: 950, y: 580, size: 24, text: "x".repeat(60) },
    { kind: "circle", beat: 0, color: "white", x: 5, y: 5, r: 3, label: null },
    { kind: "box", beat: 0, color: "white", x: 0, y: 0, w: 1000, h: 600, label: null },
  ];
  variants.forEach((el, i) => assertFiniteOps(elementOps(el, chalkSeed(1, i)), `variant ${i}`));

  // Text stays inside the board by the width heuristic.
  for (const op of elementOps(variants[5]!, 7)) {
    if (op.type !== "text") continue;
    assert.ok(op.x >= 8);
    assert.ok(op.x + op.text.length * op.size * 0.55 <= BOARD_WIDTH - 8 + 1e-6);
  }
});

void test("every pose, face and accessory draws a finite figure", () => {
  let i = 0;
  for (const pose of CHALK_POSES) {
    for (const face of CHALK_FACES) {
      for (const accessory of CHALK_ACCESSORIES) {
        const el: ChalkElement = {
          ...(base("figure") as Extract<ChalkElement, { kind: "figure" }>),
          x: i % 2 === 0 ? 150 : 880,
          y: i % 3 === 0 ? 590 : 420,
          size: 60 + (i % 5) * 70,
          pose,
          face,
          accessory,
          label: i % 2 === 0 ? "Ada" : null,
          say: i % 3 === 0 ? "A slightly longer line that needs wrapping inside the bubble" : null,
        };
        const ops = elementOps(el, chalkSeed(2, i));
        assertFiniteOps(ops, `${pose}/${face}/${accessory}`);
        assert.ok(ops.filter((op) => op.type === "stroke").length >= 6, "figure needs head, body and limbs");
        i++;
      }
    }
  }
});

function strokePoints(el: ChalkElement): Pt[] {
  const [op] = elementOps(el, chalkSeed(3, 0));
  assert.ok(op?.type === "stroke");
  return op.points;
}

function within(points: readonly Pt[], box: [number, number, number, number], slack: number): boolean {
  const [x0, y0, x1, y1] = box;
  return points.every(([x, y]) => x >= x0 - slack && x <= x1 + slack && y >= y0 - slack && y <= y1 + slack);
}

function passesNear(points: readonly Pt[], target: Pt, slack: number): boolean {
  return points.some(([x, y]) => Math.hypot(x - target[0], y - target[1]) < slack);
}

void test("paths keep sharp corners and smooth only gentle runs", () => {
  const steps: Pt[] = [[100, 500], [100, 450], [160, 450], [160, 400], [220, 400], [220, 350], [280, 350]];
  const stairs = strokePoints({ kind: "path", beat: 0, color: "white", points: steps, closed: false });
  assert.ok(within(stairs, [100, 350, 280, 500], 4), "stairs overshoot their corners");
  for (const corner of steps) assert.ok(passesNear(stairs, corner, 2), `missed corner ${corner.join(",")}`);

  const corners: Pt[] = [[400, 500], [500, 330], [600, 500]];
  const triangle = strokePoints({ kind: "path", beat: 0, color: "white", points: corners, closed: true });
  assert.ok(within(triangle, [400, 330, 600, 500], 4), "triangle balloons into a blob");
  for (const corner of corners) assert.ok(passesNear(triangle, corner, 2), `missed corner ${corner.join(",")}`);
  assert.ok(Math.hypot(triangle[0]![0] - triangle.at(-1)![0], triangle[0]![1] - triangle.at(-1)![1]) < 2, "loop not closed");

  const samples: Pt[] = Array.from({ length: 13 }, (_, i) => [100 + i * 50, 300 + 40 * Math.sin((i * Math.PI) / 4)]);
  const wave = strokePoints({ kind: "path", beat: 0, color: "white", points: samples, closed: false });
  assert.ok(wave.length > samples.length * 3, "wave was not smoothed");
  for (let i = 1; i < wave.length - 1; i++) {
    const [a, b, c] = [wave[i - 1]!, wave[i]!, wave[i + 1]!];
    const turn = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
    assert.ok(Math.min(turn, 2 * Math.PI - turn) < (15 * Math.PI) / 180, `wave kinks at point ${i}`);
  }
});

void test("labels break between words and hyphenate only words that can't fit", () => {
  assert.deepEqual(fitLabel("2★ 3-cost", 74, 55, 26).lines, ["2★", "3-cost"]);
  assert.deepEqual(fitLabel("Shared unit pool", 60, 40, 26).lines, ["Shared", "unit", "pool"]);
  assert.deepEqual(fitLabel("Authentication", 70, 60, 26).lines, ["Authent-", "ication"]);
  assert.deepEqual(fitLabel("Authentication", 200, 60, 26).lines, ["Authentication"]);
  assert.deepEqual(wrapText("a supercalifragilistic word", 8), ["a", "superca-", "lifragi-", "listic", "word"]);
});

const figureAt = (x: number, y: number, extra: Partial<Extract<ChalkElement, { kind: "figure" }>> = {}): ChalkElement => ({
  ...(base("figure") as Extract<ChalkElement, { kind: "figure" }>),
  x,
  y,
  ...extra,
});

void test("a later figure or caption in the same spot replaces the earlier one", () => {
  const elements: ChalkElement[] = [
    figureAt(300, 500, { label: "Mia", pose: "stand" }),
    { kind: "text", beat: 0, color: "white", x: 600, y: 150, size: 30, text: "Price: $5" },
    figureAt(330, 500, { beat: 1, label: "Mia", pose: "arms_up" }),
    { kind: "text", beat: 1, color: "yellow", x: 605, y: 152, size: 30, text: "Price: $8" },
    figureAt(800, 500, { beat: 1, label: "Mia" }),
    { kind: "text", beat: 1, color: "white", x: 600, y: 260, size: 30, text: "Demand rises" },
    figureAt(305, 505, { beat: 2, label: "Mia", pose: "shrug" }),
  ];
  assert.deepEqual(findReplacements(elements), [2, 3, 6, null, null, null, null]);

  // Same beat never replaces; a different name only when standing right on top.
  assert.deepEqual(findReplacements([figureAt(300, 500), figureAt(300, 500)]), [null, null]);
  assert.deepEqual(findReplacements([figureAt(300, 500, { label: "Ann" }), figureAt(360, 500, { beat: 1, label: "Bo" })]), [null, null]);
  assert.deepEqual(findReplacements([figureAt(300, 500, { label: "Ann" }), figureAt(310, 500, { beat: 1, label: "Bo" })]), [1, null]);

  const geometry = buildSceneGeometry({ elements }, 0);
  assert.deepEqual(geometry.map((g) => g.replacedBy), [2, 3, 6, null, null, null, null]);
  assert.deepEqual(geometry.map((g) => g.eraseInk > 0), [false, false, true, true, false, false, true]);
  for (const g of geometry) assert.ok(g.bounds && g.bounds.x1 > g.bounds.x0 && g.bounds.y1 > g.bounds.y0);
});

void test("a replacement erases first, then draws, split by ink", () => {
  const near = (reveal: number, erase: number, draw: number) => {
    const got = replaceReveal(reveal, 280, 720);
    assert.ok(Math.abs(got.erase - erase) < 1e-9 && Math.abs(got.draw - draw) < 1e-9, `${reveal}: ${JSON.stringify(got)}`);
  };
  near(0, 0, 0);
  near(0.14, 0.5, 0);
  near(0.28, 1, 0);
  near(0.64, 1, 0.5);
  near(1, 1, 1);
  assert.deepEqual(replaceReveal(0.4, 0, 720), { erase: 0, draw: 0.4 });
});

void test("catch-up skips elements that a late replacement would erase anyway", () => {
  const items: RevealItem[] = [
    { beat: 0, ink: 600, replacedBy: 1 },
    { beat: 1, ink: 900, replacedBy: null },
  ];
  // Art arrives during scene 0's second beat, when both are overdue.
  const at = 6;
  const arrival: ArrivalInfo = { at, frame: frameAt(at, BEATS, FULL_TIMELINE) };
  const mid = reveal(at + CATCHUP_ERASE_SECONDS + 0.3, { elements: items, arrival });
  assert.equal(mid.elements[0], 0);
  assert.ok(mid.elements[1]! > 0, "the replacement catches up immediately");
});

void test("bubbles and labels move off art that would cover them", () => {
  const speaker = figureAt(300, 450, { size: 180, label: "Mia", say: "Prices are going up again!" });
  const preferred = elementOps(speaker, chalkSeed(0, 0));
  const bubbleText = preferred.filter((op): op is Extract<PaintOp, { type: "text" }> => op.type === "text" && op.text !== "Mia");
  const top = Math.min(...bubbleText.map((op) => op.y)) - 20;
  const bottom = Math.max(...bubbleText.map((op) => op.y)) + 20;
  const left = Math.min(...bubbleText.map((op) => op.x)) - 10;
  // A block of text exactly where the bubble would go, and another under her feet.
  const crowd: ChalkElement[] = [
    speaker,
    { kind: "box", beat: 0, color: "yellow", x: left, y: top, w: 260, h: bottom - top, label: "Supply shock" },
    { kind: "text", beat: 0, color: "white", x: 250, y: 462, size: 30, text: "Here" },
  ];
  const geometry = buildSceneGeometry({ elements: crowd }, 0);
  const placed = geometry[0]!.ops.filter((op): op is Extract<PaintOp, { type: "text" }> => op.type === "text");
  const box = crowd[1] as Extract<ChalkElement, { kind: "box" }>;
  for (const op of placed) {
    if (op.text === "Mia") {
      assert.ok(op.y < 450, "name label should move beside the legs, off the text under her feet");
      continue;
    }
    const inside = op.x >= box.x - 5 && op.x <= box.x + box.w && op.y >= box.y && op.y <= box.y + box.h;
    assert.ok(!inside, `bubble line "${op.text}" still sits on the box`);
  }
  assert.ok(placed.some((op) => op.text !== "Mia"), "bubble text missing");

  // With nothing in the way, the preferred spots are kept.
  assert.deepEqual(buildSceneGeometry({ elements: [speaker] }, 0)[0]!.ops, preferred);
});

void test("bubbles keep off check and cross marks, which would read as marking the speech", () => {
  // A cross clipping the corner of the preferred bubble: only a few stroke cells, but it reads as crossing out the line.
  const elements: ChalkElement[] = [
    figureAt(830, 520, { size: 160, pose: "point_left", label: null }),
    { kind: "cross", beat: 1, color: "pink", x: 660, y: 400, size: 40 },
    figureAt(690, 520, { beat: 2, size: 120, pose: "hold", accessory: "cap", label: "Blade", say: "Hold the line!" }),
  ];
  const bubble = buildSceneGeometry({ elements }, 0)[2]!.ops.filter(
    (op): op is Extract<PaintOp, { type: "text" }> => op.type === "text" && op.text !== "Blade",
  );
  assert.ok(bubble.length > 0, "bubble text missing");
  for (const op of bubble) {
    const right = op.x + op.text.length * op.size * 0.5;
    const hits = right > 640 && op.x < 680 && op.y + op.size / 2 + 8 > 380 && op.y - op.size / 2 - 8 < 420;
    assert.ok(!hits, `bubble line "${op.text}" at ${op.x},${op.y} sits on the cross`);
  }
});

void test("geometry is deterministic per seed", () => {
  const el = base("figure");
  assert.deepEqual(elementOps(el, 42), elementOps(el, 42));
  assert.notDeepEqual(elementOps(el, 42), elementOps(el, 43));
  assert.deepEqual(buildSceneGeometry(DRAWING, 0), buildSceneGeometry(DRAWING, 0));
  assert.notEqual(chalkSeed(0, 1), chalkSeed(1, 0));
  SCENE0_GEOMETRY.forEach((g, i) => {
    assert.equal(g.beat, DRAWING.elements[i]!.beat);
    assert.equal(g.ink, opsInk(g.ops));
  });
});

// ---------------------------------------------------------------- partial prefix

void test("partial prefixes cut strokes by arc length and text by characters", () => {
  const poly: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  assert.equal(polylineLength(poly), 20);
  assert.deepEqual(truncatePolyline(poly, 0.75), [
    [0, 0],
    [10, 0],
    [10, 5],
  ]);
  assert.deepEqual(truncatePolyline(poly, 0.25), [
    [0, 0],
    [5, 0],
  ]);
  assert.deepEqual(truncatePolyline(poly, 1), poly);
  assert.deepEqual(truncatePolyline(poly, 0), [[0, 0]]);
  assert.equal(polylineLength(truncatePolyline(poly, 0.6)), 12);

  assert.equal(revealedChars("hello", 0.5), 2);
  assert.equal(revealedChars("hello", 1), 5);
  assert.equal(revealedChars("hello", 0), 0);

  const a: PaintOp = {
    type: "stroke",
    points: [
      [0, 0],
      [10, 0],
    ],
    color: "white",
    ink: 10,
    weight: 1,
    alpha: 1,
  };
  const b: PaintOp = {
    type: "stroke",
    points: [
      [0, 10],
      [30, 10],
    ],
    color: "white",
    ink: 30,
    weight: 1,
    alpha: 1,
  };
  const t: PaintOp = {
    type: "text",
    x: 100,
    y: 50,
    size: 20,
    text: "abcd",
    font: "hand",
    color: "white",
    align: "left",
    ink: 40,
    alpha: 1,
  };

  assert.deepEqual(revealSlices([a, b], 0), { slices: [], pen: null });
  assert.deepEqual(revealSlices([a, b], 1), {
    slices: [
      { op: a, fraction: 1 },
      { op: b, fraction: 1 },
    ],
    pen: null,
  });
  const half = revealSlices([a, b], 0.5);
  assert.equal(half.slices.length, 2);
  assert.equal(half.slices[0]!.fraction, 1);
  assert.ok(Math.abs(half.slices[1]!.fraction - 1 / 3) < 1e-9);
  assert.ok(Math.abs(half.pen![0] - 10) < 1e-9);
  assert.equal(half.pen![1], 10);

  const quarter = revealSlices([a, b], 0.2);
  assert.deepEqual(quarter.slices, [{ op: a, fraction: 0.8 }]);

  const text = revealSlices([a, t], 0.6);
  assert.equal(text.slices[1]!.op, t);
  assert.equal(text.slices[1]!.fraction, 0.5);
  assert.equal(revealedChars(t.text, text.slices[1]!.fraction), 2);
  assert.equal(text.pen![0], 100 + 2 * 20 * 0.55);
});
