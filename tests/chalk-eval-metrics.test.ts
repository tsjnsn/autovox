import assert from "node:assert/strict";
import test from "node:test";
import { lessonMetrics, sceneMetrics } from "../scripts/chalk-eval/metrics";
import type { ChalkLesson, ChalkSceneDrawing } from "../utils/chalk/types";

const figure = (x: number, label: string | null, beat = 0) => ({
  kind: "figure" as const,
  beat,
  color: "white" as const,
  x,
  y: 520,
  size: 150,
  pose: "stand" as const,
  face: "happy" as const,
  accessory: "none" as const,
  label,
  say: null,
});

const text = (x: number, y: number, words: string, beat = 0) => ({
  kind: "text" as const,
  beat,
  color: "white" as const,
  x,
  y,
  size: 30,
  text: words,
});

void test("lesson metrics count words and flag scenes outside the beat range", () => {
  const lesson: ChalkLesson = {
    title: "T",
    cast: [{ name: "Ana", accessory: "hat", role: "learner" }],
    scenes: [
      { heading: "A", visual: "", beats: [{ say: "one two three", note: "n" }] },
      {
        heading: "B",
        visual: "",
        beats: [
          { say: "four five", note: "n" },
          { say: Array.from({ length: 50 }, () => "w").join(" "), note: "n" },
        ],
      },
    ],
    estimatedSeconds: 30,
  };
  assert.deepEqual(lessonMetrics(lesson), {
    scenes: 2,
    beats: 3,
    words: 55,
    scenesOffBeatRange: 1,
    longLines: 1,
    castSize: 1,
  });
});

void test("scene metrics flag overlapping text and ignored beats", () => {
  const clean: ChalkSceneDrawing = {
    elements: [figure(200, "Ana"), text(600, 200, "gold now"), text(600, 400, "cap later", 1)],
  };
  const cleanMetrics = sceneMetrics(clean, 0, 3);
  assert.equal(cleanMetrics.elements, 3);
  assert.equal(cleanMetrics.figures, 1);
  assert.equal(cleanMetrics.textCollisions, 0);
  assert.equal(cleanMetrics.textOverFigures, 0);
  assert.equal(cleanMetrics.emptyBeats, 1);

  const cluttered: ChalkSceneDrawing = {
    elements: [
      figure(200, null),
      text(600, 200, "gold now"),
      text(610, 205, "cap later"),
      text(160, 440, "over the figure"),
    ],
  };
  const clutteredMetrics = sceneMetrics(cluttered, 0, 1);
  assert.equal(clutteredMetrics.textCollisions, 1);
  assert.equal(clutteredMetrics.textOverFigures, 1);
  assert.equal(clutteredMetrics.emptyBeats, 0);
});
