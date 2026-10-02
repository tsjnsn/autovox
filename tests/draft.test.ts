import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIEF_DRAFT_KEYS,
  LESSON_DRAFT_KEYS,
  countWords,
  draftStrings,
  draftText,
} from "../utils/draft";

const brief = JSON.stringify({
  headline: "Rates hold",
  lede: "The central bank kept rates \"steady\" today.",
  segments: ["Markets shrugged.", "Analysts expect\na cut in March."],
  estimatedSeconds: 60,
});

const lesson = JSON.stringify({
  title: "How tides work",
  cast: [{ name: "Moon", accessory: "none", role: "pulls" }],
  scenes: [
    {
      heading: "The pull",
      visual: { kind: "diagram", label: "ignored" },
      beats: [
        { say: "The moon tugs on the ocean.", note: "gravity" },
        { say: "Water bulges toward it.", note: "bulge" },
      ],
    },
  ],
  estimatedSeconds: 40,
});

void test("spoken fields come out in order, other strings are skipped", () => {
  assert.deepEqual(draftStrings(brief, BRIEF_DRAFT_KEYS), [
    "Rates hold",
    'The central bank kept rates "steady" today.',
    "Markets shrugged.",
    "Analysts expect a cut in March.",
  ]);
  assert.deepEqual(draftStrings(lesson, LESSON_DRAFT_KEYS), [
    "How tides work",
    "The pull",
    "The moon tugs on the ocean.",
    "Water bulges toward it.",
  ]);
});

void test("the draft joins fields into one line", () => {
  assert.equal(
    draftText(brief, BRIEF_DRAFT_KEYS),
    'Rates hold — The central bank kept rates "steady" today. — Markets shrugged. — Analysts expect a cut in March.',
  );
});

void test("every cut of the stream extends the previous draft", () => {
  for (const [json, keys] of [
    [brief, BRIEF_DRAFT_KEYS],
    [lesson, LESSON_DRAFT_KEYS],
  ] as const) {
    let previous = "";
    for (let end = 0; end <= json.length; end++) {
      const draft = draftText(json.slice(0, end), keys);
      assert.ok(
        draft.startsWith(previous),
        `cut at ${end}: ${JSON.stringify(draft)} does not extend ${JSON.stringify(previous)}`,
      );
      previous = draft;
    }
    assert.equal(previous, draftText(json, keys));
  }
});

void test("a cut mid-string keeps the partial value and drops a partial escape", () => {
  assert.deepEqual(draftStrings('{"headline":"Rates ho', BRIEF_DRAFT_KEYS), ["Rates ho"]);
  assert.deepEqual(draftStrings('{"lede":"say \\', BRIEF_DRAFT_KEYS), ["say "]);
  assert.deepEqual(draftStrings('{"lede":"caf\\u00e', BRIEF_DRAFT_KEYS), ["caf"]);
  assert.deepEqual(draftStrings('{"lede":"caf\\u00e9"}', BRIEF_DRAFT_KEYS), ["café"]);
  assert.deepEqual(draftStrings('{"head', BRIEF_DRAFT_KEYS), []);
});

void test("word counts work with and without spaces between words", () => {
  assert.equal(countWords("The moon tugs on the ocean."), 6);
  assert.equal(countWords(""), 0);
  assert.ok(countWords("月が海を引っ張る") > 1);
});
