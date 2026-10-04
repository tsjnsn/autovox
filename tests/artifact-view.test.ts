import assert from "node:assert/strict";
import test from "node:test";
import { readArtifactSummaries, readSavedTape } from "../utils/artifactView";

void test("the player list keeps well-formed summaries and drops the rest", () => {
  const summaries = readArtifactSummaries({
    ok: true,
    artifacts: [
      {
        id: "a",
        createdAt: 10,
        format: "brief",
        headline: "Moon pull",
        sourceTitle: "Tides",
        siteName: "Example",
      },
      { id: "", headline: "nope", format: "brief" },
      { id: "b", headline: "Board", format: "slideshow" },
    ],
  });
  assert.deepEqual(summaries, [
    {
      id: "a",
      createdAt: 10,
      format: "brief",
      headline: "Moon pull",
      sourceTitle: "Tides",
      siteName: "Example",
    },
  ]);
  assert.deepEqual(readArtifactSummaries(null), []);
});

void test("a saved tape needs a script and ignores the page address", () => {
  const tape = readSavedTape({
    ok: true,
    artifact: {
      id: "a",
      createdAt: 10,
      format: "chalkboard",
      headline: "Tides",
      sourceTitle: "Tide tables",
      siteName: "Example",
      pageUrl: "https://news.example/tides",
      script: {
        headline: "Tides",
        lede: "The moon pulls.",
        segments: ["Sailors kept tables."],
        estimatedSeconds: 40,
      },
      lesson: { title: "Tides", cast: [], scenes: [], estimatedSeconds: 40 },
      drawings: [null],
    },
  });
  assert.equal(tape?.id, "a");
  assert.equal(tape?.script.lede, "The moon pulls.");
  assert.equal(tape?.lesson?.title, "Tides");
  assert.equal("pageUrl" in (tape ?? {}), false);
  assert.equal(readSavedTape({ ok: true, artifact: { id: "a", format: "brief", headline: "x" } }), null);
});
