import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEconomics,
  type EconomicsSnapshot,
} from "../scripts/lib/operator";

function snapshot(
  overrides: Partial<EconomicsSnapshot["daily"][number]> = {},
): EconomicsSnapshot {
  return {
    snapshotVersion: 1,
    sinceDate: "2026-09-01",
    budget: null,
    daily: [
      {
        date: "2026-09-01",
        sessionsStarted: 0,
        sessionsCompleted: 0,
        sessionsFaulted: 0,
        sessionsAborted: 0,
        sessionsExpired: 0,
        providerCostMicroUsd: 0,
        reservedMicroUsd: 0,
        creditsConsumed: 0,
        grossRevenueMicroUsd: 0,
        confirmedPayments: 0,
        ...overrides,
      },
    ],
  };
}

test("freezes before proposing product work", () => {
  const input = snapshot({ sessionsStarted: 20, sessionsCompleted: 20 });
  input.budget = {
    windowStart: 0,
    windowEnd: 1,
    capMicroUsd: 1_000_000,
    consumedMicroUsd: 1_100_000,
    reservedMicroUsd: 0,
    frozen: true,
    freezeReason: "hard cap",
  };
  const decision = evaluateEconomics(input);
  assert.equal(decision.objective, "freeze");
  assert.equal(decision.action, "stop");
  assert.deepEqual(decision.allowedPaths, []);
});

test("prioritizes paid conversion after ten unpaid trials", () => {
  const decision = evaluateEconomics(
    snapshot({
      sessionsStarted: 10,
      sessionsCompleted: 9,
      confirmedPayments: 0,
    }),
  );
  assert.equal(decision.objective, "improve_paid_conversion");
});

test("prioritizes reliability before margin", () => {
  const decision = evaluateEconomics(
    snapshot({
      sessionsStarted: 10,
      sessionsCompleted: 5,
      sessionsFaulted: 5,
      confirmedPayments: 2,
      grossRevenueMicroUsd: 18_000_000,
      providerCostMicroUsd: 9_000_000,
    }),
  );
  assert.equal(decision.objective, "reduce_fault_waste");
});

test("holds when ten payments are healthy", () => {
  const decision = evaluateEconomics(
    snapshot({
      sessionsStarted: 20,
      sessionsCompleted: 18,
      sessionsFaulted: 1,
      sessionsAborted: 1,
      confirmedPayments: 10,
      grossRevenueMicroUsd: 90_000_000,
      providerCostMicroUsd: 10_000_000,
    }),
  );
  assert.equal(decision.objective, "hold");
  assert.equal(decision.action, "hold");
});
