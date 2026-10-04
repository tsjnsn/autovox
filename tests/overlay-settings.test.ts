import assert from "node:assert/strict";
import test from "node:test";
import { overlaySettings, overlaySettingsView } from "../utils/overlaySettings";
import { readOverlaySettings } from "../utils/overlayView";
import { DEFAULT_SETTINGS } from "../utils/types";

const view = {
  providerMode: "byok" as const,
  voice: "sage" as const,
  reportLength: "standard" as const,
  outputLanguage: "en" as const,
  articleType: "infer" as const,
  hasAuth: true,
  narrationModel: "gpt-audio-mini",
};

function applySettings(next: { providerMode: string }): string {
  return next.providerMode === "managed" ? "managed" : "byok";
}

void test("the overlay settings view is key-free and always has providerMode", () => {
  const shown = overlaySettings({
    ...DEFAULT_SETTINGS,
    apiKey: "sk-openai",
    openRouterApiKey: "sk-or-user",
  });
  assert.equal(shown.providerMode, "byok");
  assert.equal(shown.hasAuth, true);
  assert.equal(shown.narrationModel, DEFAULT_SETTINGS.ttsModel);
  assert.ok(!("apiKey" in shown));
  assert.ok(!("openRouterApiKey" in shown));
});

void test("a missing GET_OVERLAY_SETTINGS response does not throw on providerMode", () => {
  const loaded = readOverlaySettings(undefined);
  assert.equal(loaded, null);
  if (loaded) applySettings(loaded);
  assert.doesNotThrow(() => {
    const next = readOverlaySettings(undefined);
    if (next) applySettings(next);
  });
});

void test("an empty sendMessage payload is not treated as overlay settings", () => {
  assert.equal(readOverlaySettings(undefined), null);
  assert.equal(readOverlaySettings(null), null);
  assert.equal(readOverlaySettings({}), null);
});

void test("a valid overlay settings view is accepted", () => {
  assert.deepEqual(readOverlaySettings(view), view);
  assert.equal(applySettings(readOverlaySettings(view)!), "byok");
});

void test("settings that still carry keys are rejected", () => {
  assert.equal(readOverlaySettings({ ...view, apiKey: "sk-openai" }), null);
  assert.equal(
    readOverlaySettings({ ...view, openRouterApiKey: "sk-or-user" }),
    null,
  );
});

void test("a missing stored settings object still yields a typed overlay view", () => {
  const shown = overlaySettingsView(undefined);
  assert.equal(typeof shown.providerMode, "string");
  assert.ok(shown.providerMode === "byok" || shown.providerMode === "managed");
  assert.equal(typeof shown.hasAuth, "boolean");
  assert.ok(!("apiKey" in shown));
});
