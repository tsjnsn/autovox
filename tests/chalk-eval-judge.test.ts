import assert from "node:assert/strict";
import test from "node:test";
import { parseJudgeOutput } from "../scripts/chalk-eval/judge";
import { summarizeJudging, type JudgeCall } from "../scripts/chalk-eval/shared";

const criteria = ["fidelity", "clarity"] as const;

void test("judge output maps blind labels back to runs, clamps scores, and ranks", () => {
  const entries = parseJudgeOutput(
    {
      boards: [
        { label: "A", fidelity: 12, clarity: 7.4, note: "busy" },
        { label: "B", fidelity: 0, clarity: 9, note: "clean" },
        { label: "B", fidelity: 5, clarity: 5, note: "duplicate ignored" },
        { label: "Z", fidelity: 5, clarity: 5, note: "unknown label ignored" },
      ],
      ranking: ["B", "A"],
    },
    "boards",
    criteria,
    [4, 2],
  );
  assert.deepEqual(entries, [
    { run: 4, scores: { fidelity: 10, clarity: 7 }, rank: 2, note: "busy" },
    { run: 2, scores: { fidelity: 1, clarity: 9 }, rank: 1, note: "clean" },
  ]);
});

void test("judging summary averages across calls and scores missing boards as last", () => {
  const calls: JudgeCall<(typeof criteria)[number]>[] = [
    {
      pass: 1,
      scene: 0,
      order: [0, 1],
      entries: [
        { run: 0, scores: { fidelity: 8, clarity: 6 }, rank: 1, note: "" },
        { run: 1, scores: { fidelity: 4, clarity: 4 }, rank: 2, note: "" },
      ],
    },
    {
      pass: 1,
      scene: 1,
      order: [1],
      entries: [{ run: 1, scores: { fidelity: 6, clarity: 6 }, rank: 1, note: "" }],
    },
    { pass: 1, scene: 2, order: [0, 1], entries: [], error: "timeout" },
  ];
  const summary = summarizeJudging(calls, criteria, 2, () => [0, 1]);
  const run0 = summary.find((s) => s.run === 0)!;
  const run1 = summary.find((s) => s.run === 1)!;
  assert.equal(run0.judged, 1);
  assert.equal(run0.missing, 1);
  assert.deepEqual(run0.criteria, { fidelity: 4.5, clarity: 3.5 });
  assert.equal(run0.meanRank, 1.5);
  assert.equal(run1.judged, 2);
  assert.equal(run1.missing, 0);
  assert.equal(run1.overall, 5);
  assert.equal(summary[0]!.run, 1);
});
