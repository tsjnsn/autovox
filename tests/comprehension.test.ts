import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { creditsForSession, type SessionKind } from "../convex/lib/economics";
import type { LlmAuth } from "../utils/auth";
import { planLesson } from "../utils/chalk/lesson";
import type { SessionFormat } from "../utils/chalk/types";
import {
  ARTICLE_TYPES,
  ARTICLE_TYPE_SPECS,
  articleHintLine,
  articleHints,
  articleTypeGuidance,
  articleTypeLabel,
  choiceChangesType,
  coerceArticleTypeChoice,
  effectiveArticleTypeChoice,
  hintedArticleType,
  pageSignalsFromJsonLd,
  parseArticleType,
  readArticleTypeField,
  rebriefCreditsLabel,
  resolveArticleType,
  withArticleTypeField,
  type ArticleType,
  type ArticleTypeChoice,
} from "../utils/comprehension";
import { BRIEF_DRAFT_KEYS, LESSON_DRAFT_KEYS, draftText } from "../utils/draft";
import { approxTokens } from "../utils/openai";
import {
  buildNarratorInstructions,
  buildNewsAnchorInstructions,
  buildTeacherInstructions,
} from "../utils/tts";
import {
  DEFAULT_SETTINGS,
  type ExtractedArticle,
  type ReportLength,
} from "../utils/types";
import { understandArticle } from "../utils/understand";

const AUTH: LlmAuth = {
  mode: "openrouter",
  apiKey: "sk-or-user",
  baseUrl: "https://openrouter.ai/api",
};

/** Lesson framing that belongs to explainers only. */
const LESSON_WORDS = /\b(teach\w*|lessons?|recap)\b/i;

function fixture(type: ArticleType): ExtractedArticle {
  return JSON.parse(
    readFileSync(`tests/fixtures/articles/${type}.json`, "utf8"),
  ) as ExtractedArticle;
}

const BARE: ExtractedArticle = {
  title: "Notes from Tuesday",
  byline: null,
  excerpt: null,
  siteName: null,
  url: "https://example.com/2026/10/notes-from-tuesday",
  textContent: "Some text.",
  length: 10,
};

type RequestBody = {
  input: Array<{ role: string; content: string }>;
  text: { format: { schema: { properties: Record<string, unknown>; required: string[] } } };
};

function withReply(reply: Record<string, unknown>) {
  const bodies: RequestBody[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as RequestBody);
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify(reply),
        usage: { input_tokens: 10, output_tokens: 5, cost: 0.00001 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return {
    bodies,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const SCRIPT = {
  headline: "Bridge shut",
  lede: "The Harbor Bridge is closed.",
  segments: ["Inspectors found cracks.", "A vote comes next month."],
  estimatedSeconds: 20,
};

const LESSON = {
  title: "Harbor Bridge",
  cast: [{ name: "Inspector", accessory: "hat", role: "the inspector" }],
  scenes: [
    {
      heading: "Bridge closed",
      visual: "A bridge with a barrier across it.",
      beats: [
        { say: "The Harbor Bridge closed this morning.", note: "Closed" },
        { say: "Inspectors found cracked bearings.", note: "Cracks" },
      ],
    },
  ],
  estimatedSeconds: 12,
};

function system(body: RequestBody | undefined): string {
  return body?.input.find((m) => m.role === "system")?.content ?? "";
}

function user(body: RequestBody | undefined): string {
  return body?.input.find((m) => m.role === "user")?.content ?? "";
}

async function brief(
  article: ExtractedArticle,
  articleType: ArticleTypeChoice | undefined,
  reply: Record<string, unknown>,
) {
  const fake = withReply(reply);
  try {
    const result = await understandArticle({
      auth: AUTH,
      model: "openai/gpt-6-luna",
      article,
      reportLength: "standard",
      outputLanguage: "auto",
      articleType,
    });
    return { result, body: fake.bodies[0] };
  } finally {
    fake.restore();
  }
}

async function board(
  article: ExtractedArticle,
  articleType: ArticleTypeChoice | undefined,
  reply: Record<string, unknown>,
) {
  const fake = withReply(reply);
  try {
    const result = await planLesson({
      auth: AUTH,
      model: "openai/gpt-6-luna",
      article,
      reportLength: "standard",
      outputLanguage: "auto",
      articleType,
    });
    return { result, body: fake.bodies[0] };
  } finally {
    fake.restore();
  }
}

// ── Parsing and fallback ────────────────────────────────────────────────────

void test("parseArticleType accepts ids, aliases, and loose spelling", () => {
  for (const type of ARTICLE_TYPES) assert.equal(parseArticleType(type), type);
  assert.equal(parseArticleType("  Opinion "), "opinion");
  assert.equal(parseArticleType("op-ed"), "opinion");
  assert.equal(parseArticleType("How-To"), "howto");
  assert.equal(parseArticleType("Q&A"), "interview");
  assert.equal(parseArticleType("profile"), "feature");
  assert.equal(parseArticleType("study"), "research");
});

void test("parseArticleType rejects anything else", () => {
  assert.equal(parseArticleType("satire"), null);
  assert.equal(parseArticleType("infer"), null);
  assert.equal(parseArticleType(""), null);
  assert.equal(parseArticleType(3), null);
  assert.equal(parseArticleType(null), null);
  assert.equal(parseArticleType(undefined), null);
});

void test("readArticleTypeField reads the reply's field and survives bad JSON", () => {
  assert.equal(readArticleTypeField('{"articleType":"news","lede":"x"}'), "news");
  assert.equal(readArticleTypeField('{"lede":"x"}'), undefined);
  assert.equal(readArticleTypeField('["news"]'), undefined);
  assert.equal(readArticleTypeField("null"), undefined);
  assert.equal(readArticleTypeField("{not json"), undefined);
});

void test("resolveArticleType: a listener's pick beats the model and the page", () => {
  const hints = articleHints(fixture("opinion"));
  assert.deepEqual(resolveArticleType("howto", "feature", hints), {
    type: "howto",
    source: "chosen",
  });
});

void test("resolveArticleType: a valid model answer wins over page hints", () => {
  const hints = articleHints(fixture("opinion"));
  assert.deepEqual(resolveArticleType("infer", "feature", hints), {
    type: "feature",
    source: "inferred",
  });
  assert.deepEqual(resolveArticleType("infer", "Op-Ed", []), {
    type: "opinion",
    source: "inferred",
  });
});

void test("resolveArticleType falls back to the page hints, then to news", () => {
  const hints = articleHints(fixture("opinion"));
  assert.deepEqual(resolveArticleType("infer", "satire", hints), {
    type: "opinion",
    source: "fallback",
  });
  assert.deepEqual(resolveArticleType("infer", undefined, []), {
    type: "news",
    source: "fallback",
  });
});

// ── Persisted setting ───────────────────────────────────────────────────────

void test("the article type setting defaults to Infer", () => {
  assert.equal(DEFAULT_SETTINGS.articleType, "infer");
});

void test("coerceArticleTypeChoice keeps stored choices and repairs the rest", () => {
  assert.equal(coerceArticleTypeChoice("infer"), "infer");
  for (const type of ARTICLE_TYPES) assert.equal(coerceArticleTypeChoice(type), type);
  assert.equal(coerceArticleTypeChoice(undefined), "infer");
  assert.equal(coerceArticleTypeChoice("Opinion"), "infer");
  assert.equal(coerceArticleTypeChoice("op-ed"), "infer");
  assert.equal(coerceArticleTypeChoice(7), "infer");
});

// ── Local page hints ────────────────────────────────────────────────────────

void test("pageSignalsFromJsonLd reads types and sections through graphs and arrays", () => {
  const signals = pageSignalsFromJsonLd(
    [
      JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage" },
          { "@type": ["OpinionNewsArticle", "NewsArticle"], articleSection: ["Opinion", "Cities"] },
        ],
      }),
      "{ not json",
      JSON.stringify([{ "@type": "BreadcrumbList" }]),
    ],
    ["Opinion", "  Transport  "],
  );
  assert.deepEqual(signals.schemaTypes, [
    "WebPage",
    "OpinionNewsArticle",
    "NewsArticle",
    "BreadcrumbList",
  ]);
  assert.deepEqual(signals.sections, ["Opinion", "Cities", "Transport"]);
});

void test("pageSignalsFromJsonLd caps how much it keeps", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ "@type": `Type${i}` }));
  const signals = pageSignalsFromJsonLd([JSON.stringify(many)], ["x".repeat(500)]);
  assert.equal(signals.schemaTypes.length, 8);
  assert.equal(signals.sections[0]?.length, 60);
});

for (const type of ARTICLE_TYPES) {
  void test(`page hints point the ${type} fixture at ${type}`, () => {
    const hints = articleHints(fixture(type));
    assert.ok(hints.length > 0);
    assert.ok(hints.length <= 6);
    assert.equal(hintedArticleType(hints), type);
  });
}

void test("a page with no metadata gives no hints and no hint line", () => {
  assert.deepEqual(articleHints(BARE), []);
  assert.equal(articleHintLine([]), null);
  assert.equal(hintedArticleType([]), null);
});

void test("the generic NewsArticle schema type is not a hint", () => {
  const hints = articleHints({
    ...BARE,
    signals: { schemaTypes: ["NewsArticle", "https://schema.org/Article"], sections: [] },
  });
  assert.deepEqual(hints, []);
});

void test("articleHintLine groups evidence by type and says it is weaker than the text", () => {
  const line = articleHintLine(articleHints(fixture("opinion")));
  assert.ok(line);
  assert.match(line, /^Page hints \(weaker than the text itself\): opinion \(/);
  assert.match(line, /schema\.org OpinionNewsArticle/);
  assert.match(line, /URL \/opinion\//);
});

// ── Prompt assembly ─────────────────────────────────────────────────────────

void test("withArticleTypeField adds a leading required field only for Infer", () => {
  const schema = {
    type: "object",
    properties: { lede: { type: "string" } },
    required: ["lede"],
  };
  const inferred = withArticleTypeField(schema, "infer") as typeof schema;
  assert.deepEqual(Object.keys(inferred.properties), ["articleType", "lede"]);
  assert.deepEqual(inferred.required, ["articleType", "lede"]);
  assert.deepEqual(
    (inferred.properties as Record<string, { enum?: string[] }>).articleType?.enum,
    [...ARTICLE_TYPES],
  );
  assert.equal(withArticleTypeField(schema, "opinion"), schema);
});

void test("a chosen type's guidance carries that type only", () => {
  for (const format of ["brief", "chalkboard"] as SessionFormat[]) {
    for (const type of ARTICLE_TYPES) {
      const guidance = articleTypeGuidance(type, format);
      assert.ok(guidance.includes(ARTICLE_TYPE_SPECS[type].arc));
      assert.equal(guidance.includes("Boards:"), format === "chalkboard");
      for (const other of ARTICLE_TYPES) {
        if (other === type) continue;
        assert.ok(!guidance.includes(ARTICLE_TYPE_SPECS[other].arc), `${type} carries ${other}`);
      }
    }
  }
});

void test("Infer guidance asks for the id first and lists every type", () => {
  const guidance = articleTypeGuidance("infer", "brief");
  assert.match(guidance, /put its id in "articleType"/);
  for (const type of ARTICLE_TYPES) {
    assert.ok(guidance.includes(`- ${type}: ${ARTICLE_TYPE_SPECS[type].cue}.`));
  }
  assert.ok(!guidance.includes("Boards:"));
  assert.ok(articleTypeGuidance("infer", "chalkboard").includes("Boards:"));
});

void test("lesson framing lives in the explainer guidance only", () => {
  for (const format of ["brief", "chalkboard"] as SessionFormat[]) {
    for (const type of ARTICLE_TYPES) {
      assert.equal(
        LESSON_WORDS.test(articleTypeGuidance(type, format)),
        type === "explainer",
        `${type} ${format}`,
      );
    }
    const inferRows = articleTypeGuidance("infer", format)
      .split("\n")
      .filter((line) => LESSON_WORDS.test(line));
    assert.ok(inferRows.length > 0);
    for (const row of inferRows) assert.match(row, /^- explainer: /);
  }
});

void test("a plain news brief has no lesson framing anywhere in its prompt", async () => {
  const { result, body } = await brief(fixture("news"), "news", SCRIPT);
  assert.ok(!LESSON_WORDS.test(system(body)));
  assert.ok(!LESSON_WORDS.test(user(body)));
  assert.match(system(body), /ARTICLE TYPE: News report, chosen by the listener/);
  assert.deepEqual(result.articleType, { type: "news", source: "chosen" });
});

for (const type of ARTICLE_TYPES) {
  void test(`a chosen ${type} brief and board prompt only that type, without Infer`, async () => {
    const article = fixture(type);
    for (const run of [
      () => brief(article, type, SCRIPT),
      () => board(article, type, LESSON),
    ]) {
      const { result, body } = await run();
      const sys = system(body);
      assert.ok(sys.includes(ARTICLE_TYPE_SPECS[type].arc));
      assert.ok(!sys.includes('put its id in "articleType"'));
      assert.equal(LESSON_WORDS.test(sys), type === "explainer", sys);
      assert.ok(!("articleType" in (body?.text.format.schema.properties ?? {})));
      assert.ok(!body?.text.format.schema.required.includes("articleType"));
      assert.ok(!user(body).includes("Page hints"));
      assert.deepEqual(result.articleType, { type, source: "chosen" });
    }
  });

  void test(`Infer on the ${type} fixture asks for the type, shares hints, and reads the answer`, async () => {
    const article = fixture(type);
    for (const run of [
      () => brief(article, "infer", { articleType: type, ...SCRIPT }),
      () => board(article, undefined, { articleType: type, ...LESSON }),
    ]) {
      const { result, body } = await run();
      const schema = body?.text.format.schema;
      assert.equal(Object.keys(schema?.properties ?? {})[0], "articleType");
      assert.equal(schema?.required[0], "articleType");
      assert.match(system(body), /put its id in "articleType"/);
      assert.match(user(body), /\nPage hints \(weaker than the text itself\): /);
      assert.deepEqual(result.articleType, { type, source: "inferred" });
    }
  });
}

void test("Infer with an unusable answer falls back to the page hints", async () => {
  const { result } = await brief(fixture("howto"), "infer", {
    articleType: "listicle",
    ...SCRIPT,
  });
  assert.deepEqual(result.articleType, { type: "howto", source: "fallback" });
});

void test("Infer with no answer and no hints falls back to news", async () => {
  const { result, body } = await board(BARE, "infer", LESSON);
  assert.ok(!user(body).includes("Page hints"));
  assert.deepEqual(result.articleType, { type: "news", source: "fallback" });
});

void test("the wire tape never prints the inferred type id", () => {
  const brief = draftText('{"articleType":"opinion","headline":"Parking","lede":"The coun', BRIEF_DRAFT_KEYS);
  assert.ok(!brief.includes("opinion"));
  assert.match(brief, /Parking/);
  const lesson = draftText('{"articleType":"howto","title":"SSH keys","cast":[', LESSON_DRAFT_KEYS);
  assert.ok(!lesson.includes("howto"));
  assert.match(lesson, /SSH keys/);
});

// ── Token budget ────────────────────────────────────────────────────────────

void test("article-type guidance stays within its prompt budget", () => {
  const tokens = (choice: ArticleTypeChoice, format: SessionFormat) =>
    approxTokens(articleTypeGuidance(choice, format).length);
  assert.ok(tokens("infer", "brief") <= 700, `${tokens("infer", "brief")}`);
  assert.ok(tokens("infer", "chalkboard") <= 1_100, `${tokens("infer", "chalkboard")}`);
  for (const type of ARTICLE_TYPES) {
    assert.ok(tokens(type, "brief") <= 150, `${type} ${tokens(type, "brief")}`);
    assert.ok(tokens(type, "chalkboard") <= 220, `${type} ${tokens(type, "chalkboard")}`);
  }
});

// ── Narration ───────────────────────────────────────────────────────────────

void test("results without an article type keep their original narrator", () => {
  assert.equal(
    buildNarratorInstructions({ articleType: undefined, chalkboard: false, outputLanguage: "auto" }),
    buildNewsAnchorInstructions("auto"),
  );
  assert.equal(
    buildNarratorInstructions({ articleType: undefined, chalkboard: true, outputLanguage: "es" }),
    buildTeacherInstructions("es"),
  );
});

void test("the news anchor reads exactly as before", () => {
  assert.ok(
    buildNewsAnchorInstructions("auto").startsWith(
      "You are a calm, clear broadcast news anchor.\nRead the user's script aloud verbatim — every word, in order.\nDo not greet, summarize, paraphrase, add commentary, or skip lines.\nUse steady pacing and a professional news tone.\nThe script arrives between <script> and </script>",
    ),
  );
  assert.ok(
    buildTeacherInstructions("auto").startsWith(
      "You are a warm, clear teacher explaining a lesson at a chalkboard.\nRead the user's script aloud verbatim — every word, in order.\nDo not greet, summarize, paraphrase, add commentary, or skip lines.\nUse an engaged, unhurried teaching pace with natural emphasis on key terms.\n",
    ),
  );
  assert.equal(
    buildNarratorInstructions({ articleType: "news", chalkboard: false, outputLanguage: "auto" }),
    buildNewsAnchorInstructions("auto"),
  );
});

void test("each article type has its own narrator, and only explainers get a teacher", () => {
  const seen = new Set<string>();
  for (const type of ARTICLE_TYPES) {
    for (const chalkboard of [false, true]) {
      const text = buildNarratorInstructions({ articleType: type, chalkboard, outputLanguage: "auto" });
      assert.ok(text.startsWith(`You are ${ARTICLE_TYPE_SPECS[type].narrator.role}.\n`));
      assert.match(text, /verbatim/);
      assert.equal(/teach/i.test(text), type === "explainer", `${type} ${chalkboard}`);
      seen.add(text);
    }
  }
  assert.equal(seen.size, ARTICLE_TYPES.length);
});

// ── Overlay picker ──────────────────────────────────────────────────────────

void test("the overlay's choice: override, then a chosen brief, then the default", () => {
  assert.equal(effectiveArticleTypeChoice(null, null, undefined), "infer");
  assert.equal(effectiveArticleTypeChoice(null, null, "opinion"), "opinion");
  assert.equal(
    effectiveArticleTypeChoice(null, { type: "feature", source: "chosen" }, "infer"),
    "feature",
  );
  assert.equal(
    effectiveArticleTypeChoice(null, { type: "feature", source: "inferred" }, "infer"),
    "infer",
  );
  assert.equal(
    effectiveArticleTypeChoice("howto", { type: "feature", source: "chosen" }, "opinion"),
    "howto",
  );
});

void test("the overlay label shows what Infer settled on", () => {
  assert.equal(articleTypeLabel("infer", null), "Infer");
  assert.equal(articleTypeLabel("infer", { type: "research", source: "inferred" }), "Infer · Research");
  assert.equal(articleTypeLabel("infer", { type: "news", source: "fallback" }), "Infer · News");
  assert.equal(articleTypeLabel("howto", { type: "news", source: "inferred" }), "How-to");
});

void test("the re-brief cost label follows the server's credit rule", () => {
  for (const kind of ["brief", "chalkboard", "tts_replay"] as SessionKind[]) {
    for (const length of ["short", "standard", "deep"] as ReportLength[]) {
      const credits = creditsForSession(kind, length);
      assert.equal(
        rebriefCreditsLabel(kind, length),
        `${credits} ${credits === 1 ? "credit" : "credits"}`,
        `${kind} ${length}`,
      );
    }
  }
  assert.equal(rebriefCreditsLabel("brief", "standard"), "1 credit");
  assert.equal(rebriefCreditsLabel("chalkboard", "deep"), "2 credits");
});

void test("a re-brief is offered only when the type could change", () => {
  assert.equal(choiceChangesType("opinion", null), false);
  assert.equal(choiceChangesType("opinion", { type: "opinion", source: "inferred" }), false);
  assert.equal(choiceChangesType("opinion", { type: "news", source: "inferred" }), true);
  assert.equal(choiceChangesType("infer", { type: "news", source: "inferred" }), false);
  assert.equal(choiceChangesType("infer", { type: "news", source: "chosen" }), true);
});
