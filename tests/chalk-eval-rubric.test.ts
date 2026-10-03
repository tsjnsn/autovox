import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  drawingRubricType,
  drawRubric,
  writeRubric,
  writingRubricType,
} from "../scripts/chalk-eval/rubric";
import {
  DRAW_CRITERIA,
  WRITE_CRITERIA,
  type EvalResults,
  type WritingRun,
} from "../scripts/chalk-eval/shared";
import type { ChalkLesson } from "../utils/chalk/types";
import {
  ARTICLE_TYPES,
  ARTICLE_TYPE_SPECS,
  type ArticleType,
  type ArticleTypeChoice,
} from "../utils/comprehension";

/** SHA-256 of the judge's rubrics before article types (scripts/chalk-eval/judge.ts). */
const EXPLAINER_WRITE_SHA256 = "ee54bdf40008b3045a7bee43a9140b6c0a14df8b78ae99330ade5d0fe2120e9d";
const EXPLAINER_DRAW_SHA256 = "df20928a9af930196fc416d99198cbf572c212716b13ddc587e97f99810565fa";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const LESSON: ChalkLesson = {
  title: "t",
  cast: [],
  scenes: [{ heading: "h", visual: "v", beats: [{ say: "s", note: "n" }] }],
  estimatedSeconds: 5,
};

function writer(type: ArticleType | null, ok = true): WritingRun {
  return {
    model: "m",
    rep: 1,
    ok,
    ms: 1,
    spend: { costUsd: 0, costUnknownCalls: 0, inputTokens: 0, outputTokens: 0 },
    ...(ok ? { lesson: LESSON } : { error: "failed" }),
    ...(type ? { articleType: { type, source: "inferred" as const } } : {}),
  };
}

function run(options: {
  choice?: ArticleTypeChoice;
  writers?: WritingRun[];
  reference?: ArticleType | "untyped" | null;
}): Pick<EvalResults, "articleTypeChoice" | "writing" | "reference"> {
  const reference = options.reference ?? null;
  return {
    articleTypeChoice: options.choice,
    writing: options.writers ?? [],
    reference:
      reference === null
        ? null
        : {
            source: "m (rep 1)",
            lesson: LESSON,
            ...(reference === "untyped"
              ? {}
              : { articleType: { type: reference, source: "inferred" as const } }),
          },
  };
}

void test("explainers and untyped runs keep the original rubrics verbatim", () => {
  assert.equal(sha(writeRubric("explainer")), EXPLAINER_WRITE_SHA256);
  assert.equal(sha(drawRubric("explainer")), EXPLAINER_DRAW_SHA256);
  assert.equal(writeRubric(undefined), writeRubric("explainer"));
  assert.equal(drawRubric(undefined), drawRubric("explainer"));
});

void test("other types are judged on their own arc with the same criteria", () => {
  for (const type of ARTICLE_TYPES) {
    if (type === "explainer") continue;
    const spec = ARTICLE_TYPE_SPECS[type];
    const write = writeRubric(type);
    const draw = drawRubric(type);
    assert.ok(write.includes(spec.arc), `${type} plan rubric names its arc`);
    assert.ok(write.includes(spec.board), `${type} plan rubric names its boards`);
    assert.ok(draw.includes(spec.board), `${type} board rubric names its boards`);
    assert.ok(write.includes(spec.label) && draw.includes(spec.label), type);
    assert.doesNotMatch(write, /expert teacher|lesson plans|genuinely teaches|recaps/, type);
    assert.doesNotMatch(draw, /narrated lesson|how well it teaches|learner/, type);
    assert.deepEqual(
      [...write.matchAll(/^- (\w+):/gm)].map((m) => m[1]),
      [...WRITE_CRITERIA],
      `${type} plan criteria`,
    );
    assert.deepEqual(
      [...draw.matchAll(/^- (\w+):/gm)].map((m) => m[1]),
      [...DRAW_CRITERIA],
      `${type} board criteria`,
    );
  }
});

void test("plans are judged as the forced type, else the writers' majority", () => {
  const writers = [writer("news"), writer("opinion"), writer("opinion")];
  assert.equal(writingRubricType(run({ choice: "feature", writers })), "feature");
  assert.equal(writingRubricType(run({ choice: "infer", writers })), "opinion");
  assert.equal(writingRubricType(run({ writers })), "opinion");
  assert.equal(
    writingRubricType(run({ writers: [writer("news"), writer("opinion")] })),
    "news",
    "the earliest writer breaks a tie",
  );
  assert.equal(
    writingRubricType(
      run({ writers: [writer("news"), writer("opinion", false), writer("opinion", false)] }),
    ),
    "news",
    "failed writers don't vote",
  );
});

void test("plans from before article types fall back to the reference, then the explainer rubric", () => {
  assert.equal(
    writingRubricType(run({ writers: [writer(null)], reference: "research" })),
    "research",
  );
  assert.equal(writingRubricType(run({ writers: [writer(null)], reference: "untyped" })), undefined);
  assert.equal(writingRubricType(run({})), undefined);
});

void test("boards are drawn and judged as the reference lesson's type", () => {
  assert.equal(
    drawingRubricType(run({ choice: "infer", writers: [writer("news")], reference: "interview" })),
    "interview",
  );
  assert.equal(
    drawingRubricType(run({ choice: "news", reference: "untyped" })),
    "news",
    "a reference from before article types takes the forced type",
  );
  assert.equal(drawingRubricType(run({ choice: "infer", reference: "untyped" })), undefined);
  assert.equal(drawingRubricType(run({ choice: "news" })), "news");
});
