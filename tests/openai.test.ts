import assert from "node:assert/strict";
import test from "node:test";
import type { LlmAuth } from "../utils/auth";
import { createStructuredResponse, OpenAIError } from "../utils/openai";

const OPENROUTER: LlmAuth = {
  mode: "openrouter",
  apiKey: "sk-or-user",
  baseUrl: "https://openrouter.ai/api",
};

const REQUEST = {
  model: "openai/gpt-4.1-mini",
  system: "Reply in JSON.",
  user: "Say ok.",
  jsonSchema: { name: "reply", schema: { type: "object" } },
};

function withFetch(responses: Response[]) {
  const bodies: Array<{ provider?: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  }) as typeof fetch;
  return { bodies, restore: () => (globalThis.fetch = original) };
}

const ok = () =>
  new Response(
    JSON.stringify({
      output_text: '{"answer":"ok"}',
      usage: { input_tokens: 5, output_tokens: 3, cost: 0.0001 },
    }),
    { status: 200 },
  );

const noEndpoints = () =>
  new Response(
    JSON.stringify({ error: { message: "No endpoints found that can handle the requested parameters." } }),
    { status: 404 },
  );

void test("retries without require_parameters when no host accepts every parameter", async () => {
  const fake = withFetch([noEndpoints(), ok()]);
  try {
    const { text } = await createStructuredResponse({ auth: OPENROUTER, ...REQUEST });
    assert.equal(text, '{"answer":"ok"}');
    assert.equal(fake.bodies.length, 2);
    assert.equal(fake.bodies[0]?.provider?.require_parameters, true);
    assert.equal(fake.bodies[1]?.provider?.require_parameters, undefined);
    assert.equal(fake.bodies[1]?.provider?.data_collection, "deny");
  } finally {
    fake.restore();
  }
});

void test("hosts that accept every parameter are used on the first try", async () => {
  const fake = withFetch([ok()]);
  try {
    await createStructuredResponse({ auth: OPENROUTER, ...REQUEST });
    assert.equal(fake.bodies.length, 1);
    assert.equal(fake.bodies[0]?.provider?.require_parameters, true);
  } finally {
    fake.restore();
  }
});

const streamFailing = (error: Record<string, unknown>) =>
  new Response(`data: ${JSON.stringify({ type: "error", error })}\n\n`, {
    status: 200,
  });

void test("a provider failure mid-stream carries a status", async () => {
  const cases: Array<[Record<string, unknown>, number | undefined]> = [
    [{ code: "server_error", message: "Provider disconnected unexpectedly" }, 502],
    [{ code: "rate_limit_exceeded", message: "Slow down" }, 429],
    [{ code: 503, message: "Provider returned error" }, 503],
    [{ code: "invalid_prompt", message: "Refused" }, undefined],
  ];
  for (const [error, status] of cases) {
    const fake = withFetch([streamFailing(error)]);
    try {
      await assert.rejects(
        createStructuredResponse({ auth: OPENROUTER, ...REQUEST, onProgress: () => {} }),
        (thrown: unknown) =>
          thrown instanceof OpenAIError &&
          thrown.message === error.message &&
          thrown.status === status,
      );
    } finally {
      fake.restore();
    }
  }
});

void test("direct OpenAI 404s are reported, not retried", async () => {
  const fake = withFetch([noEndpoints()]);
  try {
    await assert.rejects(
      createStructuredResponse({
        auth: { mode: "apiKey", apiKey: "sk-openai", baseUrl: "https://api.openai.com" },
        ...REQUEST,
      }),
      /No endpoints found/,
    );
    assert.equal(fake.bodies.length, 1);
  } finally {
    fake.restore();
  }
});
