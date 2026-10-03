import { describe, expect, test } from "vitest";
import { internal } from "../../convex/_generated/api";
import {
  createAccount,
  createTest,
  DAY_MS,
  expectManagedError,
  getBalance,
  getMetric,
  getSession,
  getWindow,
  MINUTE_MS,
  NOW,
  pendingJobs,
  purchaseCredits,
  reserveArgs,
  TODAY,
  useManagedEnvironment,
} from "./harness";

useManagedEnvironment();

describe("reserve", () => {
  test("reserves credits, both budget windows, and metrics for a trial account", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "trial");

    const { sessionId, reservedCredits } = await t.mutation(
      internal.sessions.reserve,
      reserveArgs(tokenIdentifier, { kind: "chalkboard" }),
    );

    expect(reservedCredits).toBe(1);
    const session = await getSession(t, sessionId);
    expect(session).toMatchObject({
      status: "reserved",
      kind: "chalkboard",
      trialFunded: true,
      reservationOpen: true,
    });
    expect((await getBalance(t, accountId)).reservedCredits).toBe(1);
    expect(await getWindow(t, "production")).toMatchObject({
      capMicroUsd: 20_000_000,
      reservedMicroUsd: 60_000,
    });
    expect(await getWindow(t, "trial")).toMatchObject({
      capMicroUsd: 5_000_000,
      reservedMicroUsd: 60_000,
    });
    expect(await getMetric(t)).toMatchObject({
      sessionsStarted: 1,
      reservedMicroUsd: 60_000,
      chalkboardStarted: 1,
    });
  });

  test("paid accounts reserve against the production window only", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "paid");
    await purchaseCredits(t, accountId, "pi_paid");

    const { sessionId } = await t.mutation(
      internal.sessions.reserve,
      reserveArgs(tokenIdentifier),
    );

    expect((await getSession(t, sessionId)).trialFunded).toBe(false);
    expect((await getWindow(t, "production"))?.reservedMicroUsd).toBe(60_000);
    expect(await getWindow(t, "trial")).toBeNull();
  });

  test("rejects accounts without enough credits", async () => {
    const t = createTest();
    const { accountId, tokenIdentifier } = await createAccount(t, "broke");
    const balance = await getBalance(t, accountId);
    await t.run(async (ctx) => {
      await ctx.db.patch("creditBalances", balance._id, { consumedCredits: 2 });
    });

    await expectManagedError(
      t.mutation(
        internal.sessions.reserve,
        reserveArgs(tokenIdentifier, { reportLength: "deep" }),
      ),
      "no_credits",
    );
    expect(await getWindow(t, "production")).toBeNull();
  });

  test("rejects a second session while one is in progress", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "busy");
    await t.mutation(internal.sessions.reserve, reserveArgs(tokenIdentifier));

    await expectManagedError(
      t.mutation(internal.sessions.reserve, reserveArgs(tokenIdentifier)),
      "session_in_progress",
    );
  });

  test("expires a stale blocking session inline and schedules its finalization", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "stale");
    const first = await t.mutation(
      internal.sessions.reserve,
      reserveArgs(tokenIdentifier),
    );
    const later = NOW + 16 * MINUTE_MS;

    await t.mutation(
      internal.sessions.reserve,
      reserveArgs(tokenIdentifier, { now: later }),
    );

    expect(await getSession(t, first.sessionId)).toMatchObject({
      status: "expired",
      outcome: "expired",
      reservationOpen: false,
      endedAt: later,
    });
    expect(await pendingJobs(t, "finalizeSession")).toHaveLength(1);
  });

  test("rejects a reused client request id", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "reuse");
    const args = reserveArgs(tokenIdentifier);
    await t.mutation(internal.sessions.reserve, args);

    await expectManagedError(
      t.mutation(internal.sessions.reserve, args),
      "request_reused",
    );
  });

  test("rejects reservations past the daily production budget", async () => {
    const t = createTest();
    const first = await createAccount(t, "first");
    const second = await createAccount(t, "second");
    const capped = { dailyBudgetMicroUsd: 100_000 };
    await t.mutation(
      internal.sessions.reserve,
      reserveArgs(first.tokenIdentifier, capped),
    );

    await expectManagedError(
      t.mutation(
        internal.sessions.reserve,
        reserveArgs(second.tokenIdentifier, capped),
      ),
      "daily_budget_reached",
    );
  });

  test("an exhausted trial pool blocks trial accounts while paid accounts still reserve", async () => {
    const t = createTest();
    const firstTrial = await createAccount(t, "trial-1");
    const secondTrial = await createAccount(t, "trial-2");
    const paid = await createAccount(t, "paid");
    await purchaseCredits(t, paid.accountId, "pi_paid");
    const budgets = {
      dailyBudgetMicroUsd: 1_000_000,
      trialDailyBudgetMicroUsd: 100_000,
    };
    await t.mutation(
      internal.sessions.reserve,
      reserveArgs(firstTrial.tokenIdentifier, budgets),
    );

    const error = await expectManagedError(
      t.mutation(
        internal.sessions.reserve,
        reserveArgs(secondTrial.tokenIdentifier, budgets),
      ),
      "trial_budget_reached",
    );
    expect(error.message).toMatch(/buy credits/i);

    const { sessionId } = await t.mutation(
      internal.sessions.reserve,
      reserveArgs(paid.tokenIdentifier, budgets),
    );
    expect((await getSession(t, sessionId)).trialFunded).toBe(false);
    expect((await getWindow(t, "trial"))?.reservedMicroUsd).toBe(60_000);
    expect((await getWindow(t, "production"))?.reservedMicroUsd).toBe(120_000);
  });

  test("frozen windows block reservations even with room left", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "frozen");
    const frozenWindow = {
      windowStart: TODAY,
      windowEnd: TODAY + DAY_MS,
      capMicroUsd: 5_000_000,
      consumedMicroUsd: 0,
      reservedMicroUsd: 0,
      frozen: true,
      updatedAt: NOW,
    };
    const trialWindowId = await t.run(
      async (ctx) =>
        await ctx.db.insert("budgetWindows", { scope: "trial", ...frozenWindow }),
    );
    await expectManagedError(
      t.mutation(internal.sessions.reserve, reserveArgs(tokenIdentifier)),
      "trial_budget_reached",
    );

    await t.run(async (ctx) => {
      await ctx.db.patch("budgetWindows", trialWindowId, { frozen: false });
      await ctx.db.insert("budgetWindows", {
        scope: "production",
        ...frozenWindow,
      });
    });
    await expectManagedError(
      t.mutation(internal.sessions.reserve, reserveArgs(tokenIdentifier)),
      "paused",
    );
  });

  test("the kill switch pauses every account until an operator clears it", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "paused");

    expect(
      await t.mutation(internal.sessions.setProductionFreeze, {
        frozen: true,
        reason: "  provider incident  ",
      }),
    ).toEqual({ frozen: true, reason: "provider incident" });
    const error = await expectManagedError(
      t.mutation(internal.sessions.reserve, reserveArgs(tokenIdentifier)),
      "paused",
    );
    expect(error.message).not.toContain("provider incident");

    expect(
      await t.mutation(internal.sessions.setProductionFreeze, {
        frozen: false,
        reason: "ignored when resuming",
      }),
    ).toEqual({ frozen: false });
    await t.mutation(internal.sessions.reserve, reserveArgs(tokenIdentifier));
  });

  test("rejects unknown and suspended accounts", async () => {
    const t = createTest();
    await expectManagedError(
      t.mutation(
        internal.sessions.reserve,
        reserveArgs("https://convex.test|nobody"),
      ),
      "account_not_initialized",
    );

    const { accountId, tokenIdentifier } = await createAccount(t, "suspended");
    await t.run(async (ctx) => {
      await ctx.db.patch("accounts", accountId, { status: "suspended" });
    });
    await expectManagedError(
      t.mutation(internal.sessions.reserve, reserveArgs(tokenIdentifier)),
      "account_suspended",
    );
  });

  test("rejects malformed requests", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "malformed");
    await expectManagedError(
      t.mutation(
        internal.sessions.reserve,
        reserveArgs(tokenIdentifier, { clientRequestId: "  " }),
      ),
      "invalid_request",
    );
    await expectManagedError(
      t.mutation(
        internal.sessions.reserve,
        reserveArgs(tokenIdentifier, { voice: "v".repeat(41) }),
      ),
      "invalid_request",
    );
  });
});
