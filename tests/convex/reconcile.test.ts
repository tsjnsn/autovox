import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  RECONCILE_BACKOFF_MS,
  RECONCILE_LEASE_MS,
  RECONCILIATION_GRACE_MS,
} from "../../convex/lib/reconciliation";
import {
  createAccount,
  createTest,
  endSession,
  expectManagedError,
  fakeOpenRouter,
  getBalance,
  getKillSwitch,
  getMetric,
  getSession,
  getWindow,
  MINUTE_MS,
  NOW,
  openSessionArgs,
  pendingJobs,
  reserveArgs,
  runReconcileCron,
  runScheduled,
  useManagedEnvironment,
  type TestConvex,
} from "./harness";

useManagedEnvironment();

const USAGE_RECHECK_DELAY_MS = 2_000;

async function completedKeyedSession(t: TestConvex, subject: string) {
  const owner = await createAccount(t, subject);
  const { sessionId } = await owner.user.action(
    api.openrouter.openSession,
    openSessionArgs(),
  );
  await owner.user.mutation(api.sessions.reportLifecycle, {
    sessionId,
    event: { type: "completed", playbackSeconds: 30 },
  });
  await runScheduled(t);
  const session = await getSession(t, sessionId);
  return {
    ...owner,
    sessionId,
    settleAt: session.keyExpiresAt + RECONCILIATION_GRACE_MS,
  };
}

describe("reconciliation", () => {
  test("settles provider usage after the grace period and deletes the key", async () => {
    const t = createTest();
    const openRouter = fakeOpenRouter();
    const { accountId, sessionId, settleAt } = await completedKeyedSession(
      t,
      "listener",
    );
    expect(await getSession(t, sessionId)).toMatchObject({
      status: "completed",
      reservationOpen: false,
      nextReconcileAt: settleAt,
    });
    expect(openRouter.calls.map((call) => call.method)).toEqual([
      "POST",
      "PATCH",
    ]);

    vi.setSystemTime(settleAt - 1);
    expect(await runReconcileCron(t)).toBe(0);

    vi.setSystemTime(settleAt);
    openRouter.usageUsd = [0.0123];
    expect(await runReconcileCron(t)).toBe(1);

    const settled = await getSession(t, sessionId);
    expect(settled).toMatchObject({
      status: "reconciled",
      costSource: "provider",
      actualMicroUsd: 12_300,
      keyCleanupComplete: true,
    });
    expect(settled.nextReconcileAt).toBeUndefined();
    expect((await getBalance(t, accountId)).consumedCredits).toBe(1);
    expect(openRouter.calls.map((call) => call.method)).toEqual([
      "POST",
      "PATCH",
      "GET",
      "GET",
      "DELETE",
    ]);
  });

  test("usage that changes between reads is retried later without counting a failure", async () => {
    const t = createTest();
    const openRouter = fakeOpenRouter();
    const { sessionId, settleAt } = await completedKeyedSession(t, "drift");
    openRouter.usageUsd = [0.01, 0.02];

    vi.setSystemTime(settleAt);
    expect(await runReconcileCron(t)).toBe(1);

    const deferredUntil = settleAt + USAGE_RECHECK_DELAY_MS + 5 * MINUTE_MS;
    expect(await getSession(t, sessionId)).toMatchObject({
      status: "completed",
      reconcileAttempts: 0,
      nextReconcileAt: deferredUntil,
    });

    vi.setSystemTime(deferredUntil);
    expect(await runReconcileCron(t)).toBe(1);
    expect(await getSession(t, sessionId)).toMatchObject({
      status: "reconciled",
      actualMicroUsd: 20_000,
      reconcileAttempts: 0,
    });
  });

  test("failures back off with one pending retry, never freeze, and settle at worst case at the end", async () => {
    const t = createTest();
    const openRouter = fakeOpenRouter();
    const { accountId, sessionId, settleAt } = await completedKeyedSession(
      t,
      "flaky",
    );
    openRouter.usageStatus = 500;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let dueAt = settleAt;
    for (const [index, delay] of RECONCILE_BACKOFF_MS.entries()) {
      vi.setSystemTime(dueAt);
      expect(await runReconcileCron(t)).toBe(1);
      expect(await getSession(t, sessionId)).toMatchObject({
        status: "reconcile_failed",
        reconcileAttempts: index + 1,
        reservationOpen: false,
        nextReconcileAt: dueAt + delay,
      });
      expect(await pendingJobs(t, "finalizeSession")).toHaveLength(0);

      vi.setSystemTime(dueAt + delay - 1);
      expect(await runReconcileCron(t)).toBe(0);
      dueAt += delay;
    }
    expect(await getKillSwitch(t)).toBeNull();
    expect((await getWindow(t, "production"))?.frozen).toBe(false);

    vi.setSystemTime(dueAt);
    expect(await runReconcileCron(t)).toBe(1);

    const settled = await getSession(t, sessionId);
    expect(settled).toMatchObject({
      status: "reconciled",
      costSource: "worst_case",
      actualMicroUsd: 60_000,
      reconcileAttempts: RECONCILE_BACKOFF_MS.length + 1,
      keyCleanupComplete: true,
    });
    expect(settled.nextReconcileAt).toBeUndefined();
    expect(await getBalance(t, accountId)).toMatchObject({
      consumedCredits: 1,
      reservedCredits: 0,
    });
    expect(await getWindow(t, "production")).toMatchObject({
      consumedMicroUsd: 60_000,
      reservedMicroUsd: 0,
      frozen: false,
    });
    expect((await getMetric(t))?.providerCostMicroUsd).toBe(60_000);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("worst-case"),
      expect.objectContaining({ sessionId, attempts: 6 }),
    );
    expect(await getKillSwitch(t)).toBeNull();
    expect(await runReconcileCron(t)).toBe(0);
  });

  test("a failed key disable blocks the account only until the key expires", async () => {
    const t = createTest();
    const openRouter = fakeOpenRouter();
    openRouter.disableStatus = 500;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { user, sessionId, settleAt } = await completedKeyedSession(
      t,
      "stuck",
    );

    expect(await getSession(t, sessionId)).toMatchObject({
      status: "reconcile_failed",
      reconcileAttempts: 1,
      reservationOpen: true,
      nextReconcileAt: settleAt,
    });
    await expectManagedError(
      user.action(api.openrouter.openSession, openSessionArgs()),
      "session_in_progress",
    );

    vi.setSystemTime(settleAt);
    openRouter.usageUsd = [0.004];
    expect(await runReconcileCron(t)).toBe(1);

    expect(await getSession(t, sessionId)).toMatchObject({
      status: "reconciled",
      costSource: "provider",
      actualMicroUsd: 4_000,
    });
    expect(
      openRouter.calls.filter((call) => call.method === "PATCH"),
    ).toHaveLength(1);
    await user.action(api.openrouter.openSession, openSessionArgs());
  });

  test("the cron schedules due sessions in due order and skips the rest", async () => {
    const t = createTest();
    const offsets = [-1 * MINUTE_MS, -3 * MINUTE_MS, 1 * MINUTE_MS];
    const sessionIds: Id<"listeningSessions">[] = [];
    for (const [index, offset] of offsets.entries()) {
      const { tokenIdentifier } = await createAccount(t, `due-${index}`);
      const { sessionId } = await t.mutation(
        internal.sessions.reserve,
        reserveArgs(tokenIdentifier),
      );
      await endSession(t, sessionId, "completed");
      await t.run(async (ctx) => {
        await ctx.db.patch("listeningSessions", sessionId, {
          nextReconcileAt: NOW + offset,
        });
      });
      sessionIds.push(sessionId);
    }
    const [later, earliest, notDue] = sessionIds;

    expect(
      await t.mutation(internal.sessions.retryPendingFinalization, {}),
    ).toBe(2);

    const jobs = await pendingJobs(t, "finalizeSession");
    expect(jobs.map((job) => job.args[0])).toEqual([
      { sessionId: earliest },
      { sessionId: later },
    ]);
    for (const sessionId of [earliest!, later!]) {
      expect((await getSession(t, sessionId)).nextReconcileAt).toBe(
        NOW + RECONCILE_LEASE_MS,
      );
    }
    expect((await getSession(t, notDue!)).nextReconcileAt).toBe(NOW + MINUTE_MS);
  });

  test("sweepExpired ends abandoned sessions and reconciles them", async () => {
    const t = createTest();
    const openRouter = fakeOpenRouter();
    const reserved = await createAccount(t, "reserved");
    const { sessionId: keyless } = await t.mutation(
      internal.sessions.reserve,
      reserveArgs(reserved.tokenIdentifier),
    );
    const active = await createAccount(t, "active");
    const { sessionId: keyed } = await active.user.action(
      api.openrouter.openSession,
      openSessionArgs(),
    );
    const keyExpiresAt = (await getSession(t, keyed)).keyExpiresAt;

    vi.setSystemTime(keyExpiresAt + 1);
    expect(await t.mutation(internal.sessions.sweepExpired, {})).toBe(2);
    await runScheduled(t);

    expect(await getSession(t, keyless)).toMatchObject({
      status: "reconciled",
      outcome: "expired",
      actualMicroUsd: 0,
    });
    expect((await getBalance(t, reserved.accountId)).consumedCredits).toBe(0);
    expect(await getSession(t, keyed)).toMatchObject({
      status: "expired",
      reservationOpen: false,
      nextReconcileAt: keyExpiresAt + RECONCILIATION_GRACE_MS,
    });
    expect(
      openRouter.calls.filter((call) => call.method === "PATCH"),
    ).toHaveLength(0);

    vi.setSystemTime(keyExpiresAt + RECONCILIATION_GRACE_MS);
    expect(await runReconcileCron(t)).toBe(1);
    expect(await getSession(t, keyed)).toMatchObject({
      status: "reconciled",
      actualMicroUsd: 0,
    });
    expect((await getBalance(t, active.accountId)).consumedCredits).toBe(0);
    expect((await getMetric(t))?.sessionsExpired).toBe(2);
  });

  test("backfill schedules sessions left pending by an older deployment", async () => {
    const t = createTest();
    const { tokenIdentifier } = await createAccount(t, "legacy");
    const { sessionId } = await t.mutation(
      internal.sessions.reserve,
      reserveArgs(tokenIdentifier),
    );
    await endSession(t, sessionId, "aborted");
    await t.run(async (ctx) => {
      await ctx.db.patch("listeningSessions", sessionId, {
        status: "reconcile_failed",
        reconcileAttempts: 3,
      });
    });
    expect(await runReconcileCron(t)).toBe(0);

    expect(
      await t.mutation(internal.sessions.backfillReconcileSchedule, {}),
    ).toBe(1);
    expect(await runReconcileCron(t)).toBe(1);
    expect((await getSession(t, sessionId)).status).toBe("reconciled");
  });
});
