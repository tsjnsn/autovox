import assert from "node:assert/strict";
import test from "node:test";
import { openRouterProviderPrefs } from "../utils/auth";

void test("BYOK OpenRouter keys do not require ZDR routing", () => {
  assert.deepEqual(
    openRouterProviderPrefs({
      mode: "openrouter",
      apiKey: "sk-or-user",
      baseUrl: "https://openrouter.ai/api",
    }),
    { provider: { data_collection: "deny" } },
  );
});

void test("managed OpenRouter keys require ZDR routing", () => {
  assert.deepEqual(
    openRouterProviderPrefs({
      mode: "openrouter",
      apiKey: "sk-or-managed",
      baseUrl: "https://openrouter.ai/api",
      managed: true,
    }),
    { provider: { zdr: true, data_collection: "deny" } },
  );
});

void test("structured requests can require hosts that honor every parameter", () => {
  assert.deepEqual(
    openRouterProviderPrefs(
      { mode: "openrouter", apiKey: "sk-or-user", baseUrl: "https://openrouter.ai/api" },
      { requireParameters: true },
    ),
    { provider: { data_collection: "deny", require_parameters: true } },
  );
});

void test("direct OpenAI keys send no OpenRouter provider preferences", () => {
  assert.deepEqual(
    openRouterProviderPrefs({
      mode: "apiKey",
      apiKey: "sk-openai",
      baseUrl: "https://api.openai.com",
    }),
    {},
  );
});
