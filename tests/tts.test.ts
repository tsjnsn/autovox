import assert from "node:assert/strict";
import test from "node:test";
import type { ChalkLesson } from "../utils/chalk/types";
import { buildTeacherInstructions, lessonTtsChunks } from "../utils/tts";

const lesson: ChalkLesson = {
  title: "Binary search",
  cast: [{ name: "Ada", accessory: "glasses", role: "the searcher" }],
  scenes: [
    {
      heading: "Halve it",
      visual: "Ada at a sorted shelf",
      beats: [
        { say: "Picture a sorted shelf.", note: "sorted shelf" },
        { say: "Open the middle book.", note: "check the middle" },
      ],
    },
    {
      heading: "Repeat",
      visual: "Shrinking range",
      beats: [{ say: "Throw away the wrong half.", note: "drop half" }],
    },
  ],
  estimatedSeconds: 20,
};

void test("narrates one request per beat in board order, title first", () => {
  assert.deepEqual(lessonTtsChunks(lesson), [
    "Binary search.\n\nPicture a sorted shelf.",
    "Open the middle book.",
    "Throw away the wrong half.",
  ]);
});

void test("teacher voice still reads verbatim in the chosen language", () => {
  const instructions = buildTeacherInstructions("fr");
  assert.match(instructions, /verbatim/);
  assert.match(instructions, /French/);
});
