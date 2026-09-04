import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUsd,
  summarizeMoneyEvents,
  type MoneyEvent,
} from "../utils/money";

const now = Date.UTC(2026, 8, 3);

function event(
  id: string,
  outcome: MoneyEvent["outcome"],
  costUsd: number,
  costKnown = true,
): MoneyEvent {
  return {
    id,
    kind: "brief",
    startedAt: now,
    endedAt: now,
    outcome,
    faultStage: outcome === "fault" ? "tts" : "none",
    costUsd,
    costKnown,
    lineItems: [],
    reportLength: "standard",
    voice: "sage",
    outputLanguage: "en",
    authMode: "openrouter",
  };
}

void test("summarizes known spend without treating unknown cost as zero", () => {
  const summary = summarizeMoneyEvents(
    [
      event("completed", "completed", 0.02),
      event("fault", "fault", 0.005),
      event("unknown", "completed", 0, false),
    ],
    now,
  );
  assert.equal(summary.briefCount, 3);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.faultCount, 1);
  assert.equal(summary.totalUsd, 0.025);
  assert.equal(summary.wastedUsd, 0.005);
  assert.equal(summary.averageCompletedUsd, 0.02);
  assert.equal(summary.costUnknownCount, 1);
});

void test("formats sub-cent costs without hiding them", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.005), "$0.0050");
  assert.equal(formatUsd(1.25), "$1.25");
});
