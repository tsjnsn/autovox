import assert from "node:assert/strict";
import test from "node:test";
import { mergeStreamUsage, emptyUsage, parseProviderUsage } from "../utils/usage";

void test("BYOK-routed calls count the provider's charge, not just OpenRouter's fee", () => {
  const usage = parseProviderUsage({
    id: "gen-1",
    usage: {
      input_tokens: 9,
      output_tokens: 5,
      cost: 0,
      is_byok: true,
      cost_details: {
        upstream_inference_cost: 0.0000034,
        upstream_inference_input_cost: 9e-7,
        upstream_inference_output_cost: 0.0000025,
      },
    },
  });
  assert.equal(usage.costKnown, true);
  assert.equal(usage.costUsd, 0.0000034);
  assert.equal(usage.inputTokens, 9);
});

void test("a BYOK fee is added to the provider's charge", () => {
  const usage = parseProviderUsage({
    usage: { cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } },
  });
  assert.ok(Math.abs((usage.costUsd ?? 0) - 0.021) < 1e-12);
});

void test("OpenRouter-billed calls keep their cost as reported", () => {
  const usage = parseProviderUsage({
    usage: { cost: 0.004, is_byok: false, cost_details: { upstream_inference_cost: 0.004 } },
  });
  assert.equal(usage.costUsd, 0.004);
});

void test("a streamed usage chunk with BYOK upstream cost fills an empty usage", () => {
  const usage = mergeStreamUsage(emptyUsage(), {
    usage: { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.5 } },
  });
  assert.equal(usage.costUsd, 0.5);
  assert.equal(usage.costKnown, true);
});
