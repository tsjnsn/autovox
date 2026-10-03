import assert from "node:assert/strict";
import test from "node:test";
import { MANAGED_ERROR_CODES, managedError } from "../convex/lib/errors";
import {
  briefErrorKind,
  errorMeterLabel,
  errorResponse,
  PageError,
  SetupError,
} from "../utils/errors";
import { OpenAIError } from "../utils/providerError";

void test("an OpenRouter upstream outage reads as Retry, not Needs setup", () => {
  const outage = new OpenAIError(
    "Provider returned error (502) — Azure: upstream connect error",
    502,
  );
  assert.equal(briefErrorKind(outage), "transient");
  assert.equal(errorMeterLabel(briefErrorKind(outage)), "Retry");
});

void test("provider statuses map to what the listener can do", () => {
  const kind = (status?: number) =>
    briefErrorKind(new OpenAIError("failed", status));
  assert.equal(kind(401), "setup");
  assert.equal(kind(403), "setup");
  assert.equal(kind(402), "credits");
  assert.equal(kind(408), "transient");
  assert.equal(kind(429), "transient");
  assert.equal(kind(500), "transient");
  assert.equal(kind(503), "transient");
  assert.equal(kind(400), "fault");
  assert.equal(kind(404), "fault");
  assert.equal(kind(undefined), "fault");
});

void test("managed codes classify by code, not message", () => {
  const kind = (code: Parameters<typeof managedError>[0]) =>
    briefErrorKind(managedError(code, "Something about an API key"));
  assert.equal(kind("not_authenticated"), "setup");
  assert.equal(kind("account_not_initialized"), "setup");
  assert.equal(kind("not_configured"), "setup");
  assert.equal(kind("no_credits"), "credits");
  assert.equal(kind("paused"), "paused");
  assert.equal(kind("daily_budget_reached"), "paused");
  assert.equal(kind("trial_budget_reached"), "paused");
  assert.equal(kind("retry_shortly"), "transient");
  assert.equal(kind("session_in_progress"), "transient");
  assert.equal(kind("provider_unavailable"), "transient");
  assert.equal(kind("invalid_request"), "fault");
  assert.equal(kind("forbidden"), "fault");
});

void test("every managed code has a short meter label", () => {
  for (const code of MANAGED_ERROR_CODES) {
    const label = errorMeterLabel(briefErrorKind(managedError(code, code)));
    assert.ok(label.length > 0 && label.length <= 11, `${code}: ${label}`);
  }
});

void test("wording alone never makes an error a setup problem", () => {
  for (const message of [
    "Invalid API key",
    "Could not connect",
    "Provider returned error",
  ]) {
    assert.equal(briefErrorKind(new Error(message)), "fault");
  }
});

void test("typed errors from the brief pipeline keep their kind", () => {
  assert.equal(briefErrorKind(new SetupError("Add a key")), "setup");
  assert.equal(
    briefErrorKind(new PageError("Not enough readable text on this page.")),
    "page",
  );
  assert.equal(briefErrorKind(new TypeError("Failed to fetch")), "transient");
  assert.equal(briefErrorKind("nope"), "fault");
});

void test("labels stay within the meter's vocabulary", () => {
  assert.equal(errorMeterLabel("setup"), "Needs setup");
  assert.equal(errorMeterLabel("credits"), "No credits");
  assert.equal(errorMeterLabel("paused"), "Retry");
  assert.equal(errorMeterLabel("transient"), "Retry");
  assert.equal(errorMeterLabel("page"), "Fault");
  assert.equal(errorMeterLabel("fault"), "Fault");
});

void test("error responses carry the server's message and code", () => {
  assert.deepEqual(
    errorResponse(managedError("no_credits", "Buy more credits"), "fallback"),
    { ok: false, error: "Buy more credits", code: "no_credits", kind: "credits" },
  );
  const plain = errorResponse(new Error("Boom"), "fallback");
  assert.deepEqual(plain, { ok: false, error: "Boom", kind: "fault" });
  assert.equal("code" in plain, false);
  assert.equal(errorResponse(undefined, "fallback").error, "fallback");
});
