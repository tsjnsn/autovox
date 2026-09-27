import assert from "node:assert/strict";
import test from "node:test";
import {
  activeModels,
  catalogModelId,
  DEFAULT_COMPREHENSION_MODEL,
  DEFAULT_TTS_MODEL,
  modelOptions,
  parseOpenAIModels,
  parseOpenRouterModels,
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
    ttsModel: "x/voice",
  };
  assert.deepEqual(activeModels({ ...settings, providerMode: "managed" }), {
    comprehension: DEFAULT_COMPREHENSION_MODEL,
    tts: DEFAULT_TTS_MODEL,
  });
  assert.deepEqual(activeModels(settings), {
    comprehension: "x/custom",
    tts: "x/voice",
  });
});
