import assert from "node:assert/strict";
import test from "node:test";
import { videoFileName } from "../utils/chalk/video";

void test("videoFileName keeps the lesson title readable", () => {
  assert.equal(videoFileName("Binary search", ".mp4"), "Binary search.mp4");
  assert.equal(videoFileName("Où va l'argent ?", ".webm"), "Où va l'argent.webm");
});

void test("videoFileName strips characters that break downloads", () => {
  assert.equal(
    videoFileName('What: "Econ" / augments?', ".mp4"),
    "What Econ augments.mp4",
  );
  assert.equal(videoFileName("Trailing dots...", ".mp4"), "Trailing dots.mp4");
});

void test("videoFileName falls back when the title is empty or too long", () => {
  assert.equal(videoFileName("  ***  ", ".mp4"), "Chalkboard.mp4");
  assert.equal(videoFileName("x".repeat(200), ".mp4"), `${"x".repeat(80)}.mp4`);
});
