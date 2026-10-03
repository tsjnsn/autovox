import assert from "node:assert/strict";
import test from "node:test";
import {
  addMoneyLine,
  finishMoneySession,
  formatUsd,
  getMoneyEvent,
  startMoneySession,
  summarizeMoneyEvents,
  summarizeMoneyLedger,
  type MoneyEvent,
  type MoneySessionDims,
} from "../utils/money";

const now = Date.UTC(2026, 8, 3);

function event(
  id: string,
  outcome: MoneyEvent["outcome"],
  costUsd: number,
  overrides: Partial<MoneyEvent> = {},
): MoneyEvent {
  return {
    id,
    kind: "brief",
    startedAt: now,
    endedAt: now,
    outcome,
    faultStage: outcome === "fault" ? "tts" : "none",
    costUsd,
    costKnown: true,
    lineItems: [],
    reportLength: "standard",
    voice: "sage",
    outputLanguage: "en",
    authMode: "openrouter",
    ...overrides,
  };
}

function stubStorage(): () => void {
  const store = new Map<string, unknown>();
  Object.assign(globalThis, {
    browser: {
      storage: {
        local: {
          get: (key: string) =>
            Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
          set: (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) {
              store.set(key, structuredClone(value));
            }
            return Promise.resolve();
          },
        },
      },
    },
  });
  return () => {
    delete (globalThis as { browser?: unknown }).browser;
  };
}

void test("summarizes known spend without treating unknown cost as zero", () => {
  const summary = summarizeMoneyEvents(
    [
      event("completed", "completed", 0.02),
      event("fault", "fault", 0.005),
      event("unknown", "completed", 0, { costKnown: false }),
    ],
    now,
  );
  assert.equal(summary.briefCount, 3);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.faultCount, 1);
  assert.equal(summary.totalUsd, 0.025);
  assert.equal(summary.wastedUsd, 0.005);
  assert.equal(summary.averageBriefUsd, 0.02);
  assert.equal(summary.costUnknownCount, 1);
});

void test("counts chalkboards apart from briefs and averages briefs only", () => {
  const summary = summarizeMoneyEvents(
    [
      event("brief-a", "completed", 0.5),
      event("brief-b", "completed", 0.25),
      event("lesson", "completed", 2, { kind: "chalkboard" }),
      event("replay", "completed", 0.125, { kind: "tts_replay" }),
      event("lesson-fault", "fault", 1, { kind: "chalkboard" }),
    ],
    now,
  );
  assert.equal(summary.briefCount, 2);
  assert.equal(summary.chalkboardCount, 2);
  assert.equal(summary.completedCount, 4);
  assert.equal(summary.faultCount, 1);
  assert.equal(summary.averageBriefUsd, 0.375);
  assert.equal(summary.totalUsd, 3.875);
  assert.equal(summary.wastedUsd, 1);
});

void test("a chalkboard session survives the stored ledger", async () => {
  const restore = stubStorage();
  try {
    const dims: MoneySessionDims = {
      kind: "chalkboard",
      reportLength: "standard",
      voice: "sage",
      outputLanguage: "en",
      authMode: "openrouter",
    };
    const id = await startMoneySession(dims);
    await addMoneyLine(id, {
      kind: "draw",
      model: "google/gemini-2.5-flash",
      costUsd: 0.5,
      costKnown: true,
    });
    await finishMoneySession(id, "completed");

    assert.equal((await getMoneyEvent(id))?.kind, "chalkboard");
    const summary = await summarizeMoneyLedger();
    assert.equal(summary.chalkboardCount, 1);
    assert.equal(summary.briefCount, 0);
    assert.equal(summary.totalUsd, 0.5);
    assert.equal(summary.averageBriefUsd, null);
  } finally {
    restore();
  }
});

void test("formats sub-cent costs without hiding them", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.005), "$0.0050");
  assert.equal(formatUsd(1.25), "$1.25");
});
