import assert from "node:assert/strict";
import test from "node:test";
import type { LlmAuth } from "../utils/auth";
import {
  DrawError,
  drawLessonScenes,
  drawScene,
  sanitizeDrawing,
} from "../utils/chalk/draw";
import { lessonToScript, parseLesson } from "../utils/chalk/lesson";
import type {
  ChalkElement,
  ChalkLesson,
  ChalkSceneDrawing,
} from "../utils/chalk/types";
import type { ProviderUsage } from "../utils/usage";

function rawLesson(overrides: Record<string, unknown> = {}) {
  return {
    title: "  Git branches  ",
    cast: [
      { name: "Ada", accessory: "glasses", role: "the learner" },
      { name: "Repo", accessory: "hat", role: "the repository" },
    ],
    scenes: [
      {
        heading: " Why branch? ",
        visual: "Ada on the left, a tree trunk in the middle.",
        beats: [
          { say: "  Ever broken main?  ", note: "Broken main" },
          { say: "Branches let you experiment safely.", note: "Safe experiments" },
        ],
      },
      {
        heading: "Make a branch",
        visual: "Ada types, Repo grows a new limb.",
        beats: [
          { say: "Run git switch dash c.", note: "git switch -c" },
          { say: "Now you're on the new branch.", note: "" },
        ],
      },
    ],
    estimatedSeconds: 42.4,
    ...overrides,
  };
}

function parse(value: unknown): ChalkLesson | null {
  return parseLesson(JSON.stringify(value));
}

void test("parseLesson trims and keeps a valid lesson", () => {
  const lesson = parse(rawLesson());
  assert.ok(lesson);
  assert.equal(lesson.title, "Git branches");
  assert.deepEqual(lesson.cast, [
    { name: "Ada", accessory: "glasses", role: "the learner" },
    { name: "Repo", accessory: "hat", role: "the repository" },
  ]);
  assert.equal(lesson.scenes.length, 2);
  assert.equal(lesson.scenes[0]?.heading, "Why branch?");
  assert.deepEqual(lesson.scenes[0]?.beats[0], {
    say: "Ever broken main?",
    note: "Broken main",
  });
  assert.equal(lesson.estimatedSeconds, 42);
});

void test("parseLesson rejects unusable output", () => {
  assert.equal(parseLesson("not json"), null);
  assert.equal(parseLesson("[]"), null);
  assert.equal(parse(rawLesson({ title: "   " })), null);
  assert.equal(parse(rawLesson({ scenes: [] })), null);
  assert.equal(parse(rawLesson({ scenes: "nope" })), null);
  assert.equal(
    parse(
      rawLesson({
        scenes: [
          { heading: "", visual: "", beats: [{ say: "Hi", note: "Hi" }] },
          { heading: "No beats", visual: "", beats: [{ say: "  ", note: "x" }] },
        ],
      }),
    ),
    null,
  );
});

void test("parseLesson drops broken scenes and beats but keeps the rest", () => {
  const lesson = parse(
    rawLesson({
      scenes: [
        { heading: "", visual: "v", beats: [{ say: "Lost", note: "" }] },
        {
          heading: "Kept",
          visual: "v",
          beats: [null, { say: "", note: "empty" }, { say: "Real beat.", note: "n" }],
        },
      ],
      cast: "nobody",
    }),
  );
  assert.ok(lesson);
  assert.deepEqual(lesson.cast, []);
  assert.deepEqual(lesson.scenes, [
    { heading: "Kept", visual: "v", beats: [{ say: "Real beat.", note: "n" }] },
  ]);
});

void test("parseLesson caps scenes, beats, headings, notes, and cast", () => {
  const beat = { say: "One two three.", note: "x".repeat(60) };
  const scene = {
    heading: "H".repeat(50),
    visual: "v",
    beats: Array.from({ length: 8 }, () => beat),
  };
  const lesson = parse(
    rawLesson({
      scenes: Array.from({ length: 12 }, () => scene),
      cast: Array.from({ length: 6 }, (_, i) => ({
        name: `Character number ${i}`,
        accessory: "cap",
        role: "r",
      })),
    }),
  );
  assert.ok(lesson);
  assert.equal(lesson.scenes.length, 10);
  assert.equal(lesson.scenes[0]?.beats.length, 6);
  assert.equal(lesson.scenes[0]?.heading, "H".repeat(40));
  assert.equal(lesson.scenes[0]?.beats[0]?.note.length, 48);
  assert.equal(lesson.cast.length, 4);
  assert.equal(lesson.cast[0]?.name, "Character numb");
});

void test("parseLesson falls back to the first six words for an empty note", () => {
  const lesson = parse(
    rawLesson({
      scenes: [
        {
          heading: "Setup",
          visual: "",
          beats: [
            { say: "First, install the package, then restart your editor.", note: "  " },
          ],
        },
      ],
    }),
  );
  assert.equal(lesson?.scenes[0]?.beats[0]?.note, "First, install the package, then restart");
  const second = parse(rawLesson());
  assert.equal(second?.scenes[1]?.beats[1]?.note, "Now you're on the new branch.");
});

void test("parseLesson coerces a bad accessory and drops nameless cast", () => {
  const lesson = parse(
    rawLesson({
      cast: [
        { name: "Bo", accessory: "monocle", role: "helper" },
        { name: "  ", accessory: "hat", role: "ghost" },
        { name: "Cy", accessory: null, role: 3 },
      ],
    }),
  );
  assert.deepEqual(lesson?.cast, [
    { name: "Bo", accessory: "none", role: "helper" },
    { name: "Cy", accessory: "none", role: "" },
  ]);
});

void test("parseLesson estimates duration from words when missing or non-positive", () => {
  const words = 3 + 5 + 5 + 6;
  const expected = Math.round(words / 2.4);
  assert.equal(parse(rawLesson({ estimatedSeconds: 0 }))?.estimatedSeconds, expected);
  assert.equal(parse(rawLesson({ estimatedSeconds: -5 }))?.estimatedSeconds, expected);
  assert.equal(parse(rawLesson({ estimatedSeconds: null }))?.estimatedSeconds, expected);
});

void test("lessonToScript flattens beats into lede and segments", () => {
  const lesson = parse(rawLesson());
  assert.ok(lesson);
  assert.deepEqual(lessonToScript(lesson), {
    headline: "Git branches",
    lede: "Ever broken main?",
    segments: [
      "Branches let you experiment safely.",
      "Run git switch dash c.",
      "Now you're on the new branch.",
    ],
    estimatedSeconds: 42,
  });
});

function el(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "text",
    beat: 0,
    color: "white",
    x: 100,
    y: 200,
    x2: null,
    y2: null,
    size: null,
    curve: null,
    text: null,
    say: null,
    pose: null,
    face: null,
    accessory: null,
    points: null,
    closed: null,
    ...overrides,
  };
}

function only(raw: Record<string, unknown>, beatCount = 3): ChalkElement {
  const { elements } = sanitizeDrawing({ elements: [raw] }, beatCount);
  assert.equal(elements.length, 1);
  return elements[0] as ChalkElement;
}

void test("sanitizeDrawing keeps a figure and maps text/say to label/say", () => {
  assert.deepEqual(
    only(
      el({
        kind: "figure",
        x: 300,
        y: 520,
        size: 160,
        pose: "wave",
        face: "happy",
        accessory: "glasses",
        text: " Ada ",
        say: "Hi!",
        color: "yellow",
        beat: 1,
      }),
    ),
    {
      kind: "figure",
      beat: 1,
      color: "yellow",
      x: 300,
      y: 520,
      size: 160,
      pose: "wave",
      face: "happy",
      accessory: "glasses",
      label: "Ada",
      say: "Hi!",
    },
  );
});

void test("sanitizeDrawing coerces enums and defaults", () => {
  const figure = only(
    el({
      kind: "figure",
      x: 300,
      y: 520,
      pose: "dance",
      face: "angry",
      accessory: "cape",
      color: "purple",
      text: "   ",
      say: "",
    }),
  );
  assert.equal(figure.kind, "figure");
  if (figure.kind !== "figure") return;
  assert.equal(figure.size, 150);
  assert.equal(figure.pose, "stand");
  assert.equal(figure.face, "neutral");
  assert.equal(figure.accessory, "none");
  assert.equal(figure.color, "white");
  assert.equal(figure.label, null);
  assert.equal(figure.say, null);
});

void test("sanitizeDrawing shifts figures so the head clears the heading band", () => {
  const figure = only(el({ kind: "figure", x: 300, y: 150, size: 150 }));
  assert.ok(figure.kind === "figure");
  assert.equal(figure.y, 230);
  assert.equal(figure.size, 150);
  assert.ok(figure.y - figure.size >= 80);

  const big = only(el({ kind: "figure", x: -50, y: 900, size: 999 }));
  assert.ok(big.kind === "figure");
  assert.equal(big.x, 0);
  assert.equal(big.y, 600);
  assert.equal(big.size, 320);

  const tiny = only(el({ kind: "figure", x: 10, y: 20, size: 5 }));
  assert.ok(tiny.kind === "figure");
  assert.equal(tiny.size, 60);
  assert.equal(tiny.y, 140);
});

void test("sanitizeDrawing clamps into the board below the heading band", () => {
  const text = only(el({ kind: "text", x: 1200, y: 10, text: "Key", size: 100 }));
  assert.deepEqual(text, {
    kind: "text",
    beat: 0,
    color: "white",
    x: 1000,
    y: 80,
    size: 64,
    text: "Key",
  });
  const low = only(el({ kind: "text", x: 10, y: 599, text: "Low" }));
  assert.ok(low.kind === "text");
  assert.equal(low.size, 30);
  assert.equal(low.y, 570);

  const code = only(el({ kind: "code", x: 50, y: 300, size: 2, text: "npm i" }));
  assert.ok(code.kind === "code");
  assert.equal(code.size, 14);

  const arrow = only(
    el({ kind: "arrow", x: -10, y: 40, x2: 1500, y2: 700, curve: 3, text: "flows" }),
  );
  assert.deepEqual(arrow, {
    kind: "arrow",
    beat: 0,
    color: "white",
    x: 0,
    y: 80,
    x2: 1000,
    y2: 600,
    curve: 1,
    label: "flows",
  });
  const straight = only(el({ kind: "arrow", x: 10, y: 100, x2: 200, y2: 100 }));
  assert.ok(straight.kind === "arrow");
  assert.equal(straight.curve, 0);
  assert.equal(straight.label, null);

  const line = only(el({ kind: "line", x: 10, y: 0, x2: 200, y2: 300 }));
  assert.deepEqual(line, {
    kind: "line",
    beat: 0,
    color: "white",
    x: 10,
    y: 80,
    x2: 200,
    y2: 300,
  });
});

void test("sanitizeDrawing maps box corners and enforces a minimum size", () => {
  assert.deepEqual(
    only(el({ kind: "box", x: 500, y: 400, x2: 300, y2: 200, text: "Cache" })),
    { kind: "box", beat: 0, color: "white", x: 300, y: 200, w: 200, h: 200, label: "Cache" },
  );
  const thin = only(el({ kind: "box", x: 995, y: 30, x2: 1100, y2: 50 }));
  assert.ok(thin.kind === "box");
  assert.equal(thin.w, 20);
  assert.equal(thin.h, 20);
  assert.equal(thin.x, 980);
  assert.equal(thin.y, 80);
});

void test("sanitizeDrawing clamps circles and checks fully inside the board", () => {
  const circle = only(el({ kind: "circle", x: 5, y: 90, size: 400, text: "Sun" }));
  assert.deepEqual(circle, {
    kind: "circle",
    beat: 0,
    color: "white",
    x: 250,
    y: 330,
    r: 250,
    label: "Sun",
  });
  const dot = only(el({ kind: "circle", x: 500, y: 300, size: 1 }));
  assert.ok(dot.kind === "circle");
  assert.equal(dot.r, 8);
  const defaulted = only(el({ kind: "circle", x: 500, y: 300 }));
  assert.ok(defaulted.kind === "circle");
  assert.equal(defaulted.r, 40);

  const check = only(el({ kind: "check", x: 0, y: 0 }));
  assert.deepEqual(check, { kind: "check", beat: 0, color: "white", x: 20, y: 100, size: 40 });
  const cross = only(el({ kind: "cross", x: 500, y: 300, size: 60, color: "pink" }));
  assert.deepEqual(cross, { kind: "cross", beat: 0, color: "pink", x: 500, y: 300, size: 60 });
});

void test("sanitizeDrawing pairs, clamps, and caps path points", () => {
  const path = only(
    el({ kind: "path", points: [0, 0, 500, 300, 2000, 700, 42], closed: true }),
  );
  assert.deepEqual(path, {
    kind: "path",
    beat: 0,
    color: "white",
    points: [
      [0, 80],
      [500, 300],
      [1000, 600],
    ],
    closed: true,
  });
  const long = only(
    el({
      kind: "path",
      points: Array.from({ length: 200 }, (_, i) => [i * 5, 100 + i * 2]).flat(),
      closed: null,
    }),
  );
  assert.ok(long.kind === "path");
  assert.equal(long.points.length, 60);
  assert.deepEqual(long.points[0], [0, 100]);
  assert.deepEqual(long.points[59], [995, 498]);
  assert.equal(long.closed, false);
});

void test("sanitizeDrawing trims and caps strings", () => {
  const text = only(
    el({ kind: "text", text: `  ${"a".repeat(80)}\n\nb\nc\nd\ne  ` }),
  );
  assert.ok(text.kind === "text");
  assert.equal(text.text, `${"a".repeat(60)}\nb\nc\nd`);

  const code = only(
    el({
      kind: "code",
      text: `\n\ndef f():\n    return 1\n${"x".repeat(50)}\n4\n5\n6\n7\n\n`,
    }),
  );
  assert.ok(code.kind === "code");
  assert.equal(code.text, `def f():\n    return 1\n${"x".repeat(40)}\n4\n5\n6`);

  const figure = only(
    el({ kind: "figure", x: 100, y: 500, text: "L".repeat(30), say: "S".repeat(50) }),
  );
  assert.ok(figure.kind === "figure");
  assert.equal(figure.label, "L".repeat(24));
  assert.equal(figure.say, "S".repeat(40));
});

void test("sanitizeDrawing drops malformed elements", () => {
  const { elements } = sanitizeDrawing(
    {
      elements: [
        null,
        "figure",
        42,
        el({ kind: "sparkle" }),
        el({ kind: "figure", x: null }),
        el({ kind: "figure", x: 100, y: Number.NaN }),
        el({ kind: "text", text: "   " }),
        el({ kind: "code", text: null }),
        el({ kind: "box", x: 10, y: 100, x2: null, y2: 200 }),
        el({ kind: "line", x: 10, y: 100, x2: 10, y2: 100 }),
        el({ kind: "arrow", x: "10", y: 100, x2: 50, y2: 200 }),
        el({ kind: "path", points: [10, 100, 20] }),
        el({ kind: "path", points: null }),
        el({ kind: "check", x: 10, y: null }),
        el({ kind: "text", text: "survivor" }),
      ],
    },
    2,
  );
  assert.equal(elements.length, 1);
  assert.equal(elements[0]?.kind, "text");
  assert.deepEqual(sanitizeDrawing(null, 2), { elements: [] });
  assert.deepEqual(sanitizeDrawing({ elements: "x" }, 2), { elements: [] });
  assert.equal(sanitizeDrawing([el({ text: "bare array" })], 2).elements.length, 1);
});

void test("sanitizeDrawing clamps beats and stable-sorts by beat", () => {
  const { elements } = sanitizeDrawing(
    {
      elements: [
        el({ text: "b2-first", beat: 9 }),
        el({ text: "b0-first", beat: -3 }),
        el({ text: "b1-first", beat: 1.4 }),
        el({ text: "b0-second", beat: 0 }),
        el({ text: "b2-second", beat: 2 }),
        el({ text: "b1-second", beat: null }),
      ],
    },
    3,
  );
  assert.deepEqual(
    elements.map((e) => [e.beat, e.kind === "text" ? e.text : ""]),
    [
      [0, "b0-first"],
      [0, "b0-second"],
      [0, "b1-second"],
      [1, "b1-first"],
      [2, "b2-first"],
      [2, "b2-second"],
    ],
  );
  assert.equal(sanitizeDrawing({ elements: [el({ text: "x", beat: 4 })] }, 0).elements[0]?.beat, 0);
});

void test("sanitizeDrawing drops elements that redraw what is already there", () => {
  const { elements } = sanitizeDrawing(
    {
      elements: [
        el({ kind: "figure", x: 300, y: 520, text: "Mia", beat: 0 }),
        el({ text: "Price: $5", x: 600, y: 150, size: 30, beat: 0 }),
        el({ kind: "box", x: 100, y: 200, x2: 300, y2: 300, text: "Shop", beat: 0 }),
        // Unchanged repeats: a nudged figure, the same caption, the same box.
        el({ kind: "figure", x: 306, y: 520, text: "Mia", beat: 1 }),
        el({ text: "Price: $5", x: 602, y: 151, size: 30, beat: 1 }),
        el({ kind: "box", x: 100, y: 200, x2: 300, y2: 300, text: "Shop", beat: 2 }),
        // Changes in place are kept (they replace what was there).
        el({ kind: "figure", x: 300, y: 520, text: "Mia", pose: "arms_up", beat: 1 }),
        el({ text: "Price: $8", x: 600, y: 150, size: 30, beat: 2 }),
        // Bringing back the old caption after it changed is a change too.
        el({ text: "Price: $5", x: 600, y: 150, size: 30, beat: 2 }),
      ],
    },
    3,
  );
  assert.deepEqual(
    elements.map((e) => `${e.beat}:${e.kind}:${e.kind === "figure" ? e.pose : e.kind === "text" ? e.text : ""}`),
    ["0:figure:stand", "0:text:Price: $5", "0:box:", "1:figure:arms_up", "2:text:Price: $8", "2:text:Price: $5"],
  );
});

void test("sanitizeDrawing caps the element count after sorting", () => {
  const raw = Array.from({ length: 50 }, (_, i) =>
    el({ text: `t${i}`, beat: i < 25 ? 1 : 0 }),
  );
  const { elements } = sanitizeDrawing({ elements: raw }, 2);
  assert.equal(elements.length, 40);
  assert.equal(elements.filter((e) => e.beat === 0).length, 25);
  const first = elements[0];
  assert.ok(first?.kind === "text");
  assert.equal(first.text, "t25");
});

const AUTH: LlmAuth = {
  mode: "apiKey",
  apiKey: "test",
  baseUrl: "https://api.openai.com",
};

function lessonWith(sceneCount: number): ChalkLesson {
  return {
    title: "T",
    cast: [],
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      heading: `Scene ${i}`,
      visual: "",
      beats: [{ say: "Hello.", note: "Hello" }],
    })),
    estimatedSeconds: 10,
  };
}

function usage(cost: number): ProviderUsage {
  return { costUsd: cost, costKnown: true };
}

function drawingFor(sceneIndex: number): ChalkSceneDrawing {
  return {
    elements: [
      { kind: "text", beat: 0, color: "white", x: 100, y: 100, size: 30, text: `s${sceneIndex}` },
    ],
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

void test("drawLessonScenes requests scene 0 first and respects concurrency", async () => {
  const requests: number[] = [];
  const drawnScenes: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const draw: typeof drawScene = async ({ sceneIndex }) => {
    requests.push(sceneIndex);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    for (let i = 0; i < 3 + ((sceneIndex * 7) % 5); i++) await tick();
    inFlight--;
    return { drawing: drawingFor(sceneIndex), usage: usage(0.01) };
  };
  const usages: ProviderUsage[] = [];
  const result = await drawLessonScenes({
    auth: AUTH,
    model: "m",
    lesson: lessonWith(7),
    outputLanguage: "en",
    concurrency: 2,
    draw,
    onScene: (sceneIndex, drawing) => {
      assert.deepEqual(drawing, drawingFor(sceneIndex));
      drawnScenes.push(sceneIndex);
    },
    onUsage: (u) => {
      usages.push(u);
    },
  });
  assert.deepEqual(result, { drawn: 7, failed: 0 });
  assert.equal(requests[0], 0);
  assert.deepEqual(requests, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(maxInFlight, 2);
  assert.deepEqual([...drawnScenes].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(usages.length, 7);
});

void test("drawLessonScenes defaults to three workers", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const draw: typeof drawScene = async ({ sceneIndex }) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick();
    inFlight--;
    return { drawing: drawingFor(sceneIndex), usage: usage(0) };
  };
  const result = await drawLessonScenes({
    auth: AUTH,
    model: "m",
    lesson: lessonWith(8),
    outputLanguage: "auto",
    draw,
    onScene: () => {},
  });
  assert.deepEqual(result, { drawn: 8, failed: 0 });
  assert.equal(maxInFlight, 3);
});

void test("drawLessonScenes retries once and reports usage for failed attempts", async () => {
  const attempts = new Map<number, number>();
  const draw: typeof drawScene = async ({ sceneIndex }) => {
    const n = (attempts.get(sceneIndex) ?? 0) + 1;
    attempts.set(sceneIndex, n);
    await tick();
    if (sceneIndex === 1 && n === 1) throw new DrawError("bad json", usage(0.5));
    if (sceneIndex === 2) throw new DrawError("always bad", usage(0.25));
    if (sceneIndex === 3) throw new Error("network");
    return { drawing: drawingFor(sceneIndex), usage: usage(0.01) };
  };
  const drawnScenes: number[] = [];
  const costs: number[] = [];
  const result = await drawLessonScenes({
    auth: AUTH,
    model: "m",
    lesson: lessonWith(4),
    outputLanguage: "en",
    draw,
    onScene: (sceneIndex) => {
      drawnScenes.push(sceneIndex);
    },
    onUsage: (u) => {
      costs.push(u.costUsd ?? 0);
    },
  });
  assert.deepEqual(result, { drawn: 2, failed: 2 });
  assert.deepEqual([...drawnScenes].sort(), [0, 1]);
  assert.deepEqual(Object.fromEntries(attempts), { 0: 1, 1: 2, 2: 2, 3: 2 });
  assert.deepEqual(
    [...costs].sort((a, b) => a - b),
    [0.01, 0.01, 0.25, 0.25, 0.5],
  );
});

void test("drawLessonScenes stops requesting once the signal aborts", async () => {
  const controller = new AbortController();
  const requests: number[] = [];
  const drawnScenes: number[] = [];
  const draw: typeof drawScene = async ({ sceneIndex, signal }) => {
    requests.push(sceneIndex);
    await tick();
    if (sceneIndex === 0) controller.abort();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return { drawing: drawingFor(sceneIndex), usage: usage(0) };
  };
  const result = await drawLessonScenes({
    auth: AUTH,
    model: "m",
    lesson: lessonWith(6),
    outputLanguage: "en",
    signal: controller.signal,
    concurrency: 1,
    draw,
    onScene: (sceneIndex) => {
      drawnScenes.push(sceneIndex);
    },
  });
  assert.deepEqual(requests, [0]);
  assert.deepEqual(drawnScenes, []);
  assert.deepEqual(result, { drawn: 0, failed: 0 });

  const already = new AbortController();
  already.abort();
  let calls = 0;
  const idle = await drawLessonScenes({
    auth: AUTH,
    model: "m",
    lesson: lessonWith(3),
    outputLanguage: "en",
    signal: already.signal,
    draw: async ({ sceneIndex }) => {
      calls++;
      return { drawing: drawingFor(sceneIndex), usage: usage(0) };
    },
    onScene: () => {},
  });
  assert.equal(calls, 0);
  assert.deepEqual(idle, { drawn: 0, failed: 0 });
});

void test("drawLessonScenes survives throwing callbacks", async () => {
  const seen: number[] = [];
  const result = await drawLessonScenes({
    auth: AUTH,
    model: "m",
    lesson: lessonWith(5),
    outputLanguage: "en",
    concurrency: 2,
    draw: async ({ sceneIndex }) => {
      await tick();
      return { drawing: drawingFor(sceneIndex), usage: usage(0) };
    },
    onScene: async (sceneIndex) => {
      seen.push(sceneIndex);
      await tick();
      if (sceneIndex % 2 === 0) throw new Error("render failed");
    },
    onUsage: () => {
      throw new Error("ledger down");
    },
  });
  assert.deepEqual(result, { drawn: 5, failed: 0 });
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4]);
});
