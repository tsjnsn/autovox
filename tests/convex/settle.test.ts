import { describe, expect, test, vi } from "vitest";
import { internal } from "../../convex/_generated/api";
import { utcDay } from "../../convex/lib/economics";
import {
  createAccount,
  createTest,
  DAY_MS,
  endSession,
  expectManagedError,
  getBalance,
  getKillSwitch,
  getMetric,
  getSession,
  getWindow,
  NOW,
  purchaseCredits,
  reserveArgs,
  TODAY,
  useManagedEnvironment,
  type ReserveArgs,
  type TestConvex,
} from "./harness";

useManagedEnvironment();

async function terminalSession(
  t: TestConvex,
  tokenIdentifier: string,
  outcome: "completed" | "fault" | "aborted",
  overrides: Partial<ReserveArgs> = {},
) {
  const { sessionId } = await t.mutation(
    internal.sessions.reserve,
    reserveArgs(tokenIdentifier, overrides),
  );
  await endSession(t, sessionId, outcome);
  return sessionId;
}

async function ledgerKinds(t: TestConvex, sessionId: string) {
  const entries = await t.run(
    async (ctx) => await ctx.db.query("creditLedger").collect(),
  );
  return entries
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.kind);
}

describe("settle", () => {
  test("completed sessions capture credits even when the provider charged nothing", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "listener");
    const sessionId = await terminalSession(t, tokenIdentifier, "completed");

    await t.mutation(internal.sessions.settle, {
      sessionId,
      actualMicroUsd: 0,
      now: NOW,
    });

    expect(await getBalance(t, accountId)).toMatchObject({
      consumedCredits: 1,
      reservedCredits: 0,
    });
    expect(await getSession(t, sessionId)).toMatchObject({
      status: "reconciled",
      costSource: "provider",
      actualMicroUsd: 0,
      reservationOpen: false,
    });
    expect(await ledgerKinds(t, sessionId)).toEqual(["reserve", "capture"]);
  });

  test("aborted sessions with no provider cost release their credits", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "quitter");
    const sessionId = await terminalSession(t, tokenIdentifier, "aborted");

    await t.mutation(internal.sessions.settle, {
      sessionId,
      actualMicroUsd: 0,
      now: NOW,
    });

    expect(await getBalance(t, accountId)).toMatchObject({
      consumedCredits: 0,
      reservedCredits: 0,
    });
    expect(await ledgerKinds(t, sessionId)).toEqual(["reserve", "release"]);
    expect((await getMetric(t))?.sessionsAborted).toBe(1);
  });

  test("faulted sessions that spent provider money capture their credits", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "faulted");
    const sessionId = await terminalSession(t, tokenIdentifier, "fault");

    await t.mutation(internal.sessions.settle, {
      sessionId,
      actualMicroUsd: 5_000,
      now: NOW,
    });

    expect((await getBalance(t, accountId)).consumedCredits).toBe(1);
    expect((await getMetric(t))?.sessionsFaulted).toBe(1);
  });

  test("updates both budget windows and the chalkboard metrics", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "chalkboard");
    const chalkboard = await terminalSession(t, tokenIdentifier, "completed", {
      kind: "chalkboard",
      reportLength: "deep",
      reservedMicroUsd: 100_000,
    });
    await t.mutation(internal.sessions.settle, {
      sessionId: chalkboard,
      actualMicroUsd: 42_000,
      now: NOW,
    });
    const brief = await terminalSession(t, tokenIdentifier, "completed");
    await t.mutation(internal.sessions.settle, {
      sessionId: brief,
      actualMicroUsd: 8_000,
      now: NOW,
    });

    for (const scope of ["production", "trial"] as const) {
      expect(await getWindow(t, scope)).toMatchObject({
        consumedMicroUsd: 50_000,
        reservedMicroUsd: 0,
        frozen: false,
      });
    }
    expect(await getMetric(t)).toMatchObject({
      sessionsStarted: 2,
      sessionsCompleted: 2,
      providerCostMicroUsd: 50_000,
      reservedMicroUsd: 0,
      creditsConsumed: 3,
      chalkboardStarted: 1,
      chalkboardCompleted: 1,
      chalkboardProviderCostMicroUsd: 42_000,
      chalkboardCreditsConsumed: 2,
    });
  });

  test("settling an already reconciled session changes nothing", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "twice");
    const sessionId = await terminalSession(t, tokenIdentifier, "completed");
    await t.mutation(internal.sessions.settle, {
      sessionId,
      actualMicroUsd: 10_000,
      now: NOW,
    });

    await t.mutation(internal.sessions.settle, {
      sessionId,
      actualMicroUsd: 99_000,
      now: NOW,
    });

    expect((await getSession(t, sessionId)).actualMicroUsd).toBe(10_000);
    expect((await getBalance(t, accountId)).consumedCredits).toBe(1);
    expect((await getWindow(t, "production"))?.consumedMicroUsd).toBe(10_000);
  });

  test("a cap overshoot freezes only that day's window", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "spender");
    await purchaseCredits(t, accountId, "pi_spender");
    const capped = { dailyBudgetMicroUsd: 100_000, reservedMicroUsd: 100_000 };
    const sessionId = await terminalSession(t, tokenIdentifier, "completed", capped);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await t.mutation(internal.sessions.settle, {
      sessionId,
      actualMicroUsd: 130_000,
      now: NOW,
    });

    expect(await getWindow(t, "production")).toMatchObject({
      consumedMicroUsd: 130_000,
      frozen: true,
      freezeReason: "Provider spend exceeded the hard daily cap",
    });
    expect(errors).toHaveBeenCalledWith(
      "Freezing the production budget window for the day",
      expect.objectContaining({ windowStart: TODAY }),
    );
    expect(await getKillSwitch(t)).toBeNull();
    await expectManagedError(
      t.mutation(internal.sessions.reserve, reserveArgs(tokenIdentifier, capped)),
      "paused",
    );

    const tomorrow = NOW + DAY_MS;
    await t.mutation(
      internal.sessions.reserve,
      reserveArgs(tokenIdentifier, { ...capped, now: tomorrow }),
    );
    expect(await getWindow(t, "production", TODAY + DAY_MS)).toMatchObject({
      frozen: false,
      reservedMicroUsd: 100_000,
    });
    expect((await getMetric(t, tomorrow))?.date).toBe(utcDay(tomorrow));
  });

  test("a trial pool overshoot leaves paid listening open", async () => {
    const t = createTest();
    const trial = await createAccount(t, "trial");
    const paid = await createAccount(t, "paid");
    await purchaseCredits(t, paid.accountId, "pi_paid");
    const budgets = { trialDailyBudgetMicroUsd: 60_000 };
    const sessionId = await terminalSession(
      t,
      trial.tokenIdentifier,
      "completed",
      budgets,
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await t.mutation(internal.sessions.settle, {
      sessionId,
      actualMicroUsd: 70_000,
      now: NOW,
    });

    expect((await getWindow(t, "trial"))?.frozen).toBe(true);
    expect((await getWindow(t, "production"))?.frozen).toBe(false);
    await expectManagedError(
      t.mutation(
        internal.sessions.reserve,
        reserveArgs(trial.tokenIdentifier, budgets),
      ),
      "trial_budget_reached",
    );
    await t.mutation(
      internal.sessions.reserve,
      reserveArgs(paid.tokenIdentifier, budgets),
    );
  });

  test("a provisioning failure releases both budget windows", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "unlucky");
    const { sessionId } = await t.mutation(
      internal.sessions.reserve,
      reserveArgs(tokenIdentifier),
    );

    await t.mutation(internal.sessions.failProvisioning, { sessionId, now: NOW });

    expect((await getSession(t, sessionId)).status).toBe("provisioning_failed");
    expect((await getBalance(t, accountId)).reservedCredits).toBe(0);
    expect((await getWindow(t, "production"))?.reservedMicroUsd).toBe(0);
    expect((await getWindow(t, "trial"))?.reservedMicroUsd).toBe(0);
  });
});
