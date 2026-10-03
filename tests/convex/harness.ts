/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { utcDay, utcDayWindow } from "../../convex/lib/economics";
import {
  managedErrorData,
  type ManagedErrorCode,
  type ManagedErrorData,
} from "../../convex/lib/errors";
import schema from "../../convex/schema";

// The @convex-dev/stripe component is not registered: no test reaches a
// component call except the one asserting that Stripe failures are wrapped.
const modules = import.meta.glob("../../convex/**/*.*s");

export const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const TODAY = utcDayWindow(NOW).start;

export function createTest() {
  return convexTest(schema, modules);
}

export type TestConvex = ReturnType<typeof createTest>;
export type ReserveArgs = FunctionArgs<typeof internal.sessions.reserve>;

/** Fake timers pinned to midday UTC, plus the env every managed path needs. */
export function useManagedEnvironment(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "test-management-key");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

export async function expectManagedError(
  promise: Promise<unknown>,
  code: ManagedErrorCode,
): Promise<ManagedErrorData> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  const data = managedErrorData(error);
  expect(data, `expected a ${code} ConvexError, got ${String(error)}`).toEqual(
    expect.objectContaining({ code }),
  );
  return data as ManagedErrorData;
}

export async function createAccount(t: TestConvex, subject: string) {
  const user = t.withIdentity({ subject });
  const status = await user.mutation(api.accounts.ensure, {});
  return {
    user,
    accountId: status.accountId as Id<"accounts">,
    tokenIdentifier: `https://convex.test|${subject}`,
  };
}

export async function purchaseCredits(
  t: TestConvex,
  accountId: Id<"accounts">,
  paymentId: string,
  now = NOW,
): Promise<boolean> {
  return await t.mutation(internal.billingInternal.applyCheckout, {
    providerEventId: `payment:${paymentId}`,
    accountId,
    stripeObjectId: paymentId,
    productKey: "credit_pack_100",
    grossMicroUsd: 9_000_000,
    currency: "usd",
    now,
  });
}

let requestCounter = 0;

export function reserveArgs(
  tokenIdentifier: string,
  overrides: Partial<ReserveArgs> = {},
): ReserveArgs {
  const now = overrides.now ?? NOW;
  const window = utcDayWindow(now);
  requestCounter += 1;
  return {
    tokenIdentifier,
    clientRequestId: `request-${requestCounter}`,
    kind: "brief",
    reportLength: "standard",
    voice: "alloy",
    outputLanguage: "en",
    extensionVersion: "0.0.0-test",
    policyVersion: "managed-v1",
    now,
    keyExpiresAt: now + 15 * MINUTE_MS,
    reservedMicroUsd: 60_000,
    budgetWindowStart: window.start,
    budgetWindowEnd: window.end,
    dailyBudgetMicroUsd: 20_000_000,
    trialDailyBudgetMicroUsd: 5_000_000,
    ...overrides,
  };
}

export function openSessionArgs(
  overrides: Partial<FunctionArgs<typeof api.openrouter.openSession>> = {},
): FunctionArgs<typeof api.openrouter.openSession> {
  requestCounter += 1;
  return {
    clientRequestId: `open-${requestCounter}`,
    kind: "brief",
    reportLength: "standard",
    voice: "alloy",
    outputLanguage: "en",
    extensionVersion: "0.0.0-test",
    ...overrides,
  };
}

/** Puts a reserved session into the terminal state a lifecycle report would. */
export async function endSession(
  t: TestConvex,
  sessionId: Id<"listeningSessions">,
  outcome: "completed" | "fault" | "aborted",
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.patch("listeningSessions", sessionId, {
      status: outcome,
      outcome,
      reservationOpen: false,
    });
  });
}

export async function getSession(
  t: TestConvex,
  sessionId: Id<"listeningSessions">,
) {
  const session = await t.run(
    async (ctx) => await ctx.db.get("listeningSessions", sessionId),
  );
  if (!session) throw new Error(`Session ${sessionId} is missing`);
  return session;
}

export async function getBalance(t: TestConvex, accountId: Id<"accounts">) {
  const balance = await t.run(
    async (ctx) =>
      await ctx.db
        .query("creditBalances")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .unique(),
  );
  if (!balance) throw new Error(`Balance for ${accountId} is missing`);
  return balance;
}

export async function getWindow(
  t: TestConvex,
  scope: "production" | "trial",
  windowStart = TODAY,
) {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("budgetWindows")
        .withIndex("by_scope_and_window", (q) =>
          q.eq("scope", scope).eq("windowStart", windowStart),
        )
        .unique(),
  );
}

export async function getMetric(t: TestConvex, now = NOW) {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("dailyMetrics")
        .withIndex("by_date", (q) => q.eq("date", utcDay(now)))
        .unique(),
  );
}

export async function getKillSwitch(t: TestConvex) {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("controlState")
        .withIndex("by_key", (q) => q.eq("key", "production"))
        .unique(),
  );
}

/** Pending scheduled jobs whose function path contains `name`, oldest first. */
export async function pendingJobs(t: TestConvex, name: string) {
  const jobs = await t.run(
    async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs.filter(
    (job) => job.state.kind === "pending" && job.name.includes(name),
  );
}

/** Runs every scheduled function, advancing fake timers for in-action sleeps. */
export async function runScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
}

/** One tick of the reconciliation cron followed by the work it schedules. */
export async function runReconcileCron(t: TestConvex): Promise<number> {
  const scheduled = await t.mutation(
    internal.sessions.retryPendingFinalization,
    {},
  );
  await runScheduled(t);
  return scheduled;
}

export type FakeOpenRouter = {
  calls: { method: string; url: string; body: unknown }[];
  createStatus: number;
  disableStatus: number;
  usageStatus: number;
  /** Dollar usage returned by successive reads; the last value repeats. */
  usageUsd: number[];
};

export function fakeOpenRouter(): FakeOpenRouter {
  const state: FakeOpenRouter = {
    calls: [],
    createStatus: 200,
    disableStatus: 200,
    usageStatus: 200,
    usageUsd: [0],
  };
  let created = 0;
  let usageReads = 0;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      state.calls.push({ method, url, body });
      if (!url.startsWith("https://openrouter.ai/api/v1/keys")) {
        return Promise.resolve(new Response("unexpected", { status: 418 }));
      }
      switch (method) {
        case "POST": {
          if (state.createStatus !== 200) {
            return Promise.resolve(
              new Response("unavailable", { status: state.createStatus }),
            );
          }
          created += 1;
          return Promise.resolve(
            json({
              key: `sk-or-v1-test-${created}`,
              data: { hash: `key-hash-${created}`.padEnd(64, "0") },
            }),
          );
        }
        case "PATCH":
          return Promise.resolve(
            new Response(null, { status: state.disableStatus }),
          );
        case "DELETE":
          return Promise.resolve(new Response(null, { status: 200 }));
        default: {
          if (state.usageStatus !== 200) {
            return Promise.resolve(
              new Response("unavailable", { status: state.usageStatus }),
            );
          }
          const index = Math.min(usageReads, state.usageUsd.length - 1);
          usageReads += 1;
          return Promise.resolve(
            json({ data: { usage: state.usageUsd[index], byok_usage: 0 } }),
          );
        }
      }
    },
  );
  return state;
}
