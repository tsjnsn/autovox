import type { FunctionArgs } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { RECONCILIATION_GRACE_MS } from "../../convex/lib/reconciliation";
import {
  createAccount,
  createTest,
  expectManagedError,
  fakeOpenRouter,
  getSession,
  NOW,
  openSessionArgs,
  pendingJobs,
  useManagedEnvironment,
  type TestConvex,
} from "./harness";

useManagedEnvironment();

type LifecycleEvent = FunctionArgs<typeof api.sessions.reportLifecycle>["event"];

async function activeSession(t: TestConvex, subject: string) {
  fakeOpenRouter();
  const owner = await createAccount(t, subject);
  const opened = await owner.user.action(
    api.openrouter.openSession,
    openSessionArgs(),
  );
  return { ...owner, sessionId: opened.sessionId };
}

describe("reportLifecycle", () => {
  test("requires sign-in", async () => {
    const t = createTest();
    const { sessionId } = await activeSession(t, "owner");
    await expectManagedError(
      t.mutation(api.sessions.reportLifecycle, {
        sessionId,
        event: { type: "playback_started" },
      }),
      "not_authenticated",
    );
  });

  test("rejects reports for another account's session", async () => {
    const t = createTest();
    const { sessionId } = await activeSession(t, "owner");
    const intruder = await createAccount(t, "intruder");

    await expectManagedError(
      intruder.user.mutation(api.sessions.reportLifecycle, {
        sessionId,
        event: { type: "completed", playbackSeconds: 1 },
      }),
      "forbidden",
    );
    expect((await getSession(t, sessionId)).status).toBe("active");
  });

  test("reports for a deleted session are not_found", async () => {
    const t = createTest();
    const { user, sessionId } = await activeSession(t, "owner");
    await t.run(async (ctx) => {
      await ctx.db.delete("listeningSessions", sessionId);
    });

    await expectManagedError(
      user.mutation(api.sessions.reportLifecycle, {
        sessionId,
        event: { type: "playback_started" },
      }),
      "not_found",
    );
  });

  test("rejects out-of-range measurements", async () => {
    const t = createTest();
    const { user, sessionId } = await activeSession(t, "owner");
    await expectManagedError(
      user.mutation(api.sessions.reportLifecycle, {
        sessionId,
        event: { type: "script_ready", estimatedSeconds: 0 },
      }),
      "invalid_request",
    );
    await expectManagedError(
      user.mutation(api.sessions.reportLifecycle, {
        sessionId,
        event: { type: "completed", playbackSeconds: -1 },
      }),
      "invalid_request",
    );
  });

  test("a terminal report ends the session once and schedules one finalization", async () => {
    const t = createTest();
    const { user, sessionId } = await activeSession(t, "owner");
    const report = (event: LifecycleEvent) =>
      user.mutation(api.sessions.reportLifecycle, { sessionId, event });

    expect(await report({ type: "script_ready", estimatedSeconds: 61.6 })).toBe(true);
    expect(await report({ type: "playback_started" })).toBe(true);
    expect(await report({ type: "fault", stage: "tts", playbackSeconds: 42 })).toBe(true);

    const ended = await getSession(t, sessionId);
    expect(ended).toMatchObject({
      status: "fault",
      outcome: "fault",
      faultStage: "tts",
      playbackSeconds: 42,
      scriptEstimatedSeconds: 62,
      playbackStartedAt: NOW,
      endedAt: NOW,
      nextReconcileAt: ended.keyExpiresAt + RECONCILIATION_GRACE_MS,
    });
    expect(await pendingJobs(t, "finalizeSession")).toHaveLength(1);

    expect(await report({ type: "aborted", playbackSeconds: 50 })).toBe(false);
    expect(await report({ type: "script_ready", estimatedSeconds: 10 })).toBe(false);
    expect((await getSession(t, sessionId)).status).toBe("fault");
    expect(await pendingJobs(t, "finalizeSession")).toHaveLength(1);
  });
});
