import assert from "node:assert/strict";
import test from "node:test";
import {
  activeModels,
  catalogModelId,
  DEFAULT_COMPREHENSION_MODEL,
  DEFAULT_DRAWING_MODEL,
  DEFAULT_TTS_MODEL,
  estimateCost,
  formatCost,
  modelChoices,
  modelOptions,
  parseOpenAIModels,
  parseOpenRouterModels,
  searchModels,
} from "../utils/models";
import { DEFAULT_SETTINGS } from "../utils/types";

void test("OpenRouter catalog splits structured-output text models from audio models", () => {
  const catalog = parseOpenRouterModels(
    {
      data: [
        {
          id: "openai/gpt-6-luna",
          name: "OpenAI: GPT-6 Luna",
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["structured_outputs", "reasoning"],
        },
        {
          id: "openai/gpt-audio-mini",
          name: "OpenAI: GPT Audio Mini",
          architecture: {
            input_modalities: ["text", "audio"],
            output_modalities: ["text", "audio"],
          },
          supported_parameters: [],
        },
        {
          id: "someone/no-json",
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["temperature"],
        },
        { id: 42 },
      ],
    },
    1,
  );
  assert.deepEqual(catalog.comprehension, [
    { id: "openai/gpt-6-luna", label: "OpenAI: GPT-6 Luna" },
  ]);
  assert.deepEqual(catalog.tts, [
    { id: "openai/gpt-audio-mini", label: "OpenAI: GPT Audio Mini" },
  ]);
  assert.equal(catalog.source, "openrouter");
});

void test("OpenAI catalog keeps reasoning and audio aliases, drops snapshots and others", () => {
  const ids = [
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-5.6-luna",
    "o4-mini",
    "gpt-4o",
    "gpt-5-chat-latest",
    "gpt-5-pro",
    "gpt-realtime",
    "gpt-audio-mini",
    "gpt-audio-mini-2026-01-19",
    "gpt-4o-mini-tts",
    "text-embedding-3-small",
  ];
  const catalog = parseOpenAIModels({ data: ids.map((id) => ({ id })) }, 1);
  assert.deepEqual(
    catalog.comprehension.map((m) => m.id),
    ["gpt-5.6-luna", "gpt-6-luna", "gpt-6-sol", "o4-mini"],
  );
  assert.deepEqual(catalog.tts.map((m) => m.id), ["gpt-audio-mini"]);
});

void test("OpenRouter catalog drops batch variants and keeps per-million prices", () => {
  const text = {
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["structured_outputs"],
  };
  const catalog = parseOpenRouterModels(
    {
      data: [
        {
          id: "anthropic/claude-opus-5.5",
          name: "Claude Opus 5.5",
          pricing: { prompt: "0.000004", completion: "0.00002" },
          ...text,
        },
        {
          id: "anthropic/claude-opus-5.5:batch",
          name: "Claude Opus 5.5 (batch)",
          pricing: { prompt: "0.000002", completion: "0.00001" },
          ...text,
        },
        {
          id: "openai/gpt-audio-mini",
          name: "GPT Audio Mini",
          pricing: {
            prompt: "0.0000006",
            completion: "0.0000024",
            audio_output: "0.0000024",
          },
          architecture: {
            input_modalities: ["text", "audio"],
            output_modalities: ["text", "audio"],
          },
        },
      ],
    },
    1,
  );
  assert.deepEqual(
    catalog.comprehension.map((m) => m.id),
    ["anthropic/claude-opus-5.5"],
  );
  const opus = catalog.comprehension[0]!.price!;
  assert.ok(Math.abs(opus.input - 4) < 1e-9);
  assert.ok(Math.abs(opus.output - 20) < 1e-9);
  assert.equal(formatCost(estimateCost("drawing", opus)!), "~$0.20");
  assert.ok(Math.abs(catalog.tts[0]!.price!.output - 2.4) < 1e-9);
});

void test("shortlist shows only available picks, in pick order, in the catalog's id format", () => {
  const options = [
    { id: "gpt-6-luna", label: "gpt-6-luna" },
    { id: "gpt-6-sol", label: "gpt-6-sol" },
    { id: "o4-mini", label: "o4-mini" },
  ];
  const { recommended, others } = modelChoices("apiKey", options, [
    { id: "anthropic/claude-opus-5.5", tag: "Best", note: "n/a on OpenAI", quality: 5 },
    { id: "openai/gpt-6-sol", tag: "Try it", note: "sol", quality: 4 },
    { id: "openai/gpt-6-luna", tag: "Cheapest", note: "luna", quality: 1 },
  ]);
  assert.deepEqual(
    recommended.map((pick) => [pick.id, pick.tag]),
    [
      ["gpt-6-sol", "Try it"],
      ["gpt-6-luna", "Cheapest"],
    ],
  );
  assert.deepEqual(others.map((option) => option.id), ["o4-mini"]);
});

void test("cost estimates scale with the role's typical usage and round sensibly", () => {
  const luna = { input: 0.1, output: 0.5 };
  assert.equal(formatCost(estimateCost("writing", luna)!), "~$0.002");
  assert.equal(formatCost(estimateCost("drawing", luna)!), "~$0.005");
  assert.equal(formatCost(estimateCost("drawing", { input: 2, output: 10 })!), "~$0.10");
  assert.equal(formatCost(0.0444), "~$0.044");
  assert.equal(formatCost(0.0004), "<$0.001");
  assert.equal(formatCost(0), "free");
  assert.equal(estimateCost("writing", undefined), null);
});

void test("model search matches every word against id or label", () => {
  const options = [
    { id: "anthropic/claude-sonnet-5", label: "Anthropic: Claude Sonnet 5" },
    { id: "anthropic/claude-opus-5.5", label: "Anthropic: Claude Opus 5.5" },
    { id: "google/gemini-3.8-flash", label: "Google: Gemini 3.8 Flash" },
  ];
  assert.deepEqual(
    searchModels(options, "claude 5.5").map((m) => m.id),
    ["anthropic/claude-opus-5.5"],
  );
  assert.equal(searchModels(options, "  ").length, 3);
  assert.equal(searchModels(options, "FLASH")[0]?.id, "google/gemini-3.8-flash");
});

void test("catalog ids convert between OpenRouter and OpenAI formats", () => {
  assert.equal(catalogModelId("openrouter", "gpt-6-luna"), "openai/gpt-6-luna");
  assert.equal(catalogModelId("openrouter", "x/y"), "x/y");
  assert.equal(catalogModelId("apiKey", "openai/gpt-6-luna"), "gpt-6-luna");
});

void test("unlisted selection stays selectable", () => {
  const options = [{ id: "a", label: "A" }];
  assert.equal(modelOptions(options, "a"), options);
  assert.equal(modelOptions(options, "b")[0]?.id, "b");
});

void test("managed listening is pinned to default models", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    comprehensionModel: "x/custom",
    drawingModel: "x/artist",
    ttsModel: "x/voice",
  };
  assert.deepEqual(activeModels({ ...settings, providerMode: "managed" }), {
    comprehension: DEFAULT_COMPREHENSION_MODEL,
    drawing: DEFAULT_COMPREHENSION_MODEL,
    tts: DEFAULT_TTS_MODEL,
  });
  assert.deepEqual(activeModels(settings), {
    comprehension: "x/custom",
    drawing: "x/artist",
    tts: "x/voice",
  });
});

void test("chalkboard drawing defaults to its own model; paid mode stays pinned", () => {
  const byok = { ...DEFAULT_SETTINGS, providerMode: "byok" as const };
  assert.equal(activeModels(byok).drawing, DEFAULT_DRAWING_MODEL);
  assert.equal(
    activeModels({ ...byok, providerMode: "managed" }).drawing,
    DEFAULT_COMPREHENSION_MODEL,
  );
});

void test("'Same as writing model' makes drawing follow the writing model", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    comprehensionModel: "openai/gpt-6-luna",
    drawingModel: "",
  };
  assert.equal(activeModels(settings).drawing, "openai/gpt-6-luna");
  assert.equal(
    activeModels({ ...settings, drawingModel: " anthropic/claude-opus-5.5 " })
      .drawing,
    "anthropic/claude-opus-5.5",
  );
});
