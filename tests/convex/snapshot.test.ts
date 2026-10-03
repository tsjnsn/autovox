import { describe, expect, test } from "vitest";
import { internal } from "../../convex/_generated/api";
import {
  createAccount,
  createTest,
  DAY_MS,
  NOW,
  reserveArgs,
  TODAY,
  useManagedEnvironment,
} from "./harness";

useManagedEnvironment();

function budgetWindow(scope: string, windowStart: number, frozen: boolean) {
  return {
    scope,
    windowStart,
    windowEnd: windowStart + DAY_MS,
    capMicroUsd: 1_000_000,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
    frozen,
    ...(frozen ? { freezeReason: "hard cap" } : {}),
    updatedAt: NOW,
  };
}

describe("operator snapshot", () => {
  test("reports the kill switch and today's windows separately", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("budgetWindows", budgetWindow("production", TODAY - DAY_MS, true));
      await ctx.db.insert("budgetWindows", budgetWindow("production", TODAY, false));
      await ctx.db.insert("budgetWindows", budgetWindow("trial", TODAY, true));
    });

    const open = await t.query(internal.operator.snapshot, {
      sinceDate: "2026-09-01",
      now: NOW,
    });
    expect(open).toMatchObject({
      snapshotVersion: 2,
      killSwitch: { frozen: false },
      budget: { windowStart: TODAY, frozen: false },
      trialBudget: { windowStart: TODAY, frozen: true, freezeReason: "hard cap" },
    });

    await t.mutation(internal.sessions.setProductionFreeze, {
      frozen: true,
      reason: "provider incident",
    });
    const paused = await t.query(internal.operator.snapshot, {
      sinceDate: "2026-09-01",
      now: NOW,
    });
    expect(paused.killSwitch).toEqual({ frozen: true, reason: "provider incident" });
    expect(paused.budget?.frozen).toBe(false);

    const tomorrow = await t.query(internal.operator.snapshot, {
      sinceDate: "2026-09-01",
      now: NOW + DAY_MS,
    });
    expect(tomorrow.budget).toBeNull();
    expect(tomorrow.trialBudget).toBeNull();
  });

  test("passes chalkboard metrics through", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "chalkboard");
    await t.mutation(
      internal.sessions.reserve,
      reserveArgs(tokenIdentifier, { kind: "chalkboard" }),
    );

    const snapshot = await t.query(internal.operator.snapshot, {
      sinceDate: "2026-10-01",
      now: NOW,
    });
    expect(snapshot.daily).toEqual([
      expect.objectContaining({
        date: "2026-10-02",
        sessionsStarted: 1,
        chalkboardStarted: 1,
        chalkboardCompleted: 0,
      }),
    ]);
  });
});
