import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { accountNotInitialized, requireActiveAccount } from "./lib/auth";
import { authedMutation } from "./lib/customFunctions";
import {
  creditsForSession,
  shouldConsumeCredits,
  utcDay,
} from "./lib/economics";
import { managedError } from "./lib/errors";
import {
  firstReconcileAt,
  RECONCILE_LEASE_MS,
  retryReconcileAt,
  USAGE_UNSETTLED_RETRY_MS,
} from "./lib/reconciliation";
import {
  faultStageValidator,
  lifecycleEventValidator,
  reportLengthValidator,
  sessionKindValidator,
  sessionOutcomeValidator,
  sessionStatusValidator,
} from "./validators";

type Session = Doc<"listeningSessions">;
type BudgetScope = "production" | "trial";
type CostSource = NonNullable<Session["costSource"]>;

const KILL_SWITCH_KEY = "production";
const OVERSHOOT_REASON = "Provider spend exceeded the hard daily cap";
const PENDING_RECONCILE_STATUSES = [
  "completed",
  "fault",
  "aborted",
  "expired",
  "reconcile_failed",
] as const;

export const reserve = internalMutation({
  args: {
    tokenIdentifier: v.string(),
    clientRequestId: v.string(),
    kind: sessionKindValidator,
    reportLength: reportLengthValidator,
    voice: v.string(),
    outputLanguage: v.string(),
    extensionVersion: v.string(),
    policyVersion: v.string(),
    now: v.number(),
    keyExpiresAt: v.number(),
    reservedMicroUsd: v.number(),
    budgetWindowStart: v.number(),
    budgetWindowEnd: v.number(),
    dailyBudgetMicroUsd: v.number(),
    trialDailyBudgetMicroUsd: v.number(),
  },
  returns: v.object({
    sessionId: v.id("listeningSessions"),
    reservedCredits: v.number(),
  }),
  handler: async (ctx, args) => {
    if (
      !args.clientRequestId.trim() ||
      args.voice.length > 40 ||
      args.outputLanguage.length > 16
    ) {
      throw invalidRequest();
    }
    if (
      args.reservedMicroUsd <= 0 ||
      args.dailyBudgetMicroUsd <= 0 ||
      args.trialDailyBudgetMicroUsd <= 0 ||
      args.keyExpiresAt <= args.now
    ) {
      throw invalidRequest();
    }

    const account = await requireActiveAccount(ctx, args.tokenIdentifier);

    const control = await ctx.db
      .query("controlState")
      .withIndex("by_key", (q) => q.eq("key", KILL_SWITCH_KEY))
      .unique();
    if (control?.frozen) {
      throw managedError(
        "paused",
        "Managed listening is paused right now. Try again later.",
      );
    }

    const existing = await ctx.db
      .query("listeningSessions")
      .withIndex("by_account_and_client_request", (q) =>
        q
          .eq("accountId", account._id)
          .eq("clientRequestId", args.clientRequestId),
      )
      .unique();
    if (existing) {
      throw managedError(
        "request_reused",
        "This listening request was already used. Start a new one.",
      );
    }

    const recent = await ctx.db
      .query("listeningSessions")
      .withIndex("by_account_and_started", (q) =>
        q.eq("accountId", account._id),
      )
      .order("desc")
      .take(10);
    let hasBlockingSession = false;
    for (const session of recent) {
      if (!session.reservationOpen) continue;
      if (
        (session.status === "reserved" || session.status === "active") &&
        session.keyExpiresAt <= args.now
      ) {
        await expireSession(ctx, session, args.now);
        continue;
      }
      hasBlockingSession = true;
    }
    if (hasBlockingSession) {
      throw managedError(
        "session_in_progress",
        "Another managed brief is still in progress. Finish or stop it first.",
      );
    }

    const balance = await ctx.db
      .query("creditBalances")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .unique();
    if (!balance) {
      throw accountNotInitialized();
    }
    const reservedCredits = creditsForSession(args.kind, args.reportLength);
    const available =
      balance.grantedCredits -
      balance.consumedCredits -
      balance.reservedCredits;
    if (available < reservedCredits) {
      throw managedError(
        "no_credits",
        "You're out of managed credits. Buy a credit pack to keep listening.",
      );
    }

    const production = await openWindow(
      ctx,
      "production",
      args,
      args.dailyBudgetMicroUsd,
    );
    if (production.frozen) {
      throw managedError(
        "paused",
        "Managed listening is paused for the rest of today (UTC). Try again tomorrow.",
      );
    }
    if (!fitsWindow(production, args.reservedMicroUsd)) {
      throw managedError(
        "daily_budget_reached",
        "Managed listening has reached today's limit. Try again tomorrow (UTC).",
      );
    }
    const trialFunded = account.firstPurchaseAt === undefined;
    const trial = trialFunded
      ? await openWindow(ctx, "trial", args, args.trialDailyBudgetMicroUsd)
      : null;
    if (trial && (trial.frozen || !fitsWindow(trial, args.reservedMicroUsd))) {
      throw managedError(
        "trial_budget_reached",
        "Free trial listening has reached today's limit. Buy credits to keep listening now, or try again tomorrow (UTC).",
      );
    }

    await ctx.db.patch("creditBalances", balance._id, {
      reservedCredits: balance.reservedCredits + reservedCredits,
      updatedAt: args.now,
    });
    for (const window of trial ? [production, trial] : [production]) {
      await ctx.db.patch("budgetWindows", window._id, {
        reservedMicroUsd: window.reservedMicroUsd + args.reservedMicroUsd,
        updatedAt: args.now,
      });
    }

    const sessionId = await ctx.db.insert("listeningSessions", {
      accountId: account._id,
      clientRequestId: args.clientRequestId,
      kind: args.kind,
      status: "reserved",
      faultStage: "none",
      reportLength: args.reportLength,
      voice: args.voice,
      outputLanguage: args.outputLanguage,
      extensionVersion: args.extensionVersion,
      policyVersion: args.policyVersion,
      reservedCredits,
      reservedMicroUsd: args.reservedMicroUsd,
      budgetWindowStart: args.budgetWindowStart,
      trialFunded,
      reservationOpen: true,
      keyCleanupComplete: false,
      keyExpiresAt: args.keyExpiresAt,
      reconcileAttempts: 0,
      startedAt: args.now,
    });

    await ctx.db.insert("creditLedger", {
      accountId: account._id,
      idempotencyKey: `reserve:${sessionId}`,
      kind: "reserve",
      grantedDelta: 0,
      consumedDelta: 0,
      reservedDelta: reservedCredits,
      sessionId,
      createdAt: args.now,
    });

    const date = utcDay(args.now);
    const chalkboard = args.kind === "chalkboard";
    const metric = await ctx.db
      .query("dailyMetrics")
      .withIndex("by_date", (q) => q.eq("date", date))
      .unique();
    if (metric) {
      await ctx.db.patch("dailyMetrics", metric._id, {
        sessionsStarted: metric.sessionsStarted + 1,
        reservedMicroUsd:
          metric.reservedMicroUsd + args.reservedMicroUsd,
        ...(chalkboard
          ? { chalkboardStarted: (metric.chalkboardStarted ?? 0) + 1 }
          : {}),
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("dailyMetrics", {
        date,
        sessionsStarted: 1,
        sessionsCompleted: 0,
        sessionsFaulted: 0,
        sessionsAborted: 0,
        sessionsExpired: 0,
        providerCostMicroUsd: 0,
        reservedMicroUsd: args.reservedMicroUsd,
        creditsConsumed: 0,
        grossRevenueMicroUsd: 0,
        confirmedPayments: 0,
        chalkboardStarted: chalkboard ? 1 : 0,
        chalkboardCompleted: 0,
        chalkboardProviderCostMicroUsd: 0,
        chalkboardCreditsConsumed: 0,
        updatedAt: args.now,
      });
    }

    return { sessionId, reservedCredits };
  },
});

export const activate = internalMutation({
  args: {
    sessionId: v.id("listeningSessions"),
    keyHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (!session) {
      throw new Error("Listening session not found");
    }
    if (session.status !== "reserved") {
      throw new Error("Listening session is not reserving funds");
    }
    await ctx.db.patch("listeningSessions", args.sessionId, {
      status: "active",
      openRouterKeyHash: args.keyHash,
    });
    return null;
  },
});

export const failProvisioning = internalMutation({
  args: {
    sessionId: v.id("listeningSessions"),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (!session || session.status !== "reserved") {
      return null;
    }

    await releaseReservation(ctx, session, args.now);
    return null;
  },
});

export const reportLifecycle = authedMutation({
  args: {
    sessionId: v.id("listeningSessions"),
    event: lifecycleEventValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (!session) {
      throw managedError(
        "not_found",
        "That listening session no longer exists.",
      );
    }
    if (session.accountId !== ctx.account._id) {
      throw managedError(
        "forbidden",
        "That listening session belongs to another account.",
      );
    }

    const now = Date.now();
    switch (args.event.type) {
      case "script_ready": {
        if (session.status !== "active") return false;
        if (
          !Number.isFinite(args.event.estimatedSeconds) ||
          args.event.estimatedSeconds <= 0 ||
          args.event.estimatedSeconds > 3_600
        ) {
          throw invalidRequest();
        }
        await ctx.db.patch("listeningSessions", session._id, {
          scriptEstimatedSeconds: Math.round(args.event.estimatedSeconds),
        });
        return true;
      }
      case "playback_started": {
        if (session.status !== "active") return false;
        await ctx.db.patch("listeningSessions", session._id, {
          playbackStartedAt: session.playbackStartedAt ?? now,
        });
        return true;
      }
      case "completed":
      case "fault":
      case "aborted": {
        if (session.status !== "active") return false;
        if (
          !Number.isFinite(args.event.playbackSeconds) ||
          args.event.playbackSeconds < 0 ||
          args.event.playbackSeconds > 24 * 60 * 60
        ) {
          throw invalidRequest();
        }
        const outcome = args.event.type;
        await ctx.db.patch("listeningSessions", session._id, {
          status: outcome,
          outcome,
          faultStage:
            args.event.type === "fault" ? args.event.stage : "none",
          playbackSeconds: args.event.playbackSeconds,
          endedAt: now,
        });
        await scheduleFinalization(ctx, session, now);
        return true;
      }
    }
  },
});

export const getForFinalize = internalQuery({
  args: { sessionId: v.id("listeningSessions") },
  returns: v.union(
    v.object({
      sessionId: v.id("listeningSessions"),
      status: sessionStatusValidator,
      outcome: v.optional(sessionOutcomeValidator),
      keyHash: v.optional(v.string()),
      keyExpiresAt: v.number(),
      reservedMicroUsd: v.number(),
      reconcileAttempts: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (!session) return null;
    return {
      sessionId: session._id,
      status: session.status,
      outcome: session.outcome,
      keyHash: session.openRouterKeyHash,
      keyExpiresAt: session.keyExpiresAt,
      reservedMicroUsd: session.reservedMicroUsd,
      reconcileAttempts: session.reconcileAttempts,
    };
  },
});

export const getKeyForDelete = internalQuery({
  args: { sessionId: v.id("listeningSessions") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    return session?.openRouterKeyHash ?? null;
  },
});

export const claimFinalize = internalMutation({
  args: {
    sessionId: v.id("listeningSessions"),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (!session || session.status === "reconciled") return false;
    if (
      session.reconcileLeaseUntil !== undefined &&
      session.reconcileLeaseUntil > args.now
    ) {
      return false;
    }
    await ctx.db.patch("listeningSessions", session._id, {
      reconcileLeaseUntil: args.now + 2 * 60 * 1000,
    });
    return true;
  },
});

export const closeReservation = internalMutation({
  args: { sessionId: v.id("listeningSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (session?.reservationOpen) {
      await ctx.db.patch("listeningSessions", session._id, {
        reservationOpen: false,
      });
    }
    return null;
  },
});

export const markKeyDeleted = internalMutation({
  args: { sessionId: v.id("listeningSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (session) {
      await ctx.db.patch("listeningSessions", session._id, {
        openRouterKeyHash: undefined,
        keyCleanupComplete: true,
      });
    }
    return null;
  },
});

export const settle = internalMutation({
  args: {
    sessionId: v.id("listeningSessions"),
    actualMicroUsd: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (!session || session.status === "reconciled") return null;
    if (
      !Number.isSafeInteger(args.actualMicroUsd) ||
      args.actualMicroUsd < 0
    ) {
      throw new Error("Invalid provider cost");
    }
    await settleSession(ctx, session, args.actualMicroUsd, "provider", args.now);
    return null;
  },
});

export const markReconcileFailed = internalMutation({
  args: {
    sessionId: v.id("listeningSessions"),
    now: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (!session || session.status === "reconciled") return 0;
    const attempts = session.reconcileAttempts + 1;
    const retryAt = retryReconcileAt(session, attempts, args.now);
    if (retryAt === null) {
      console.error(
        "Provider usage reconciliation exhausted its retries; settling at the worst-case cost",
        {
          sessionId: session._id,
          attempts,
          reservedMicroUsd: session.reservedMicroUsd,
        },
      );
      await ctx.db.patch("listeningSessions", session._id, {
        reconcileAttempts: attempts,
      });
      await settleSession(
        ctx,
        session,
        session.reservedMicroUsd,
        "worst_case",
        args.now,
      );
      return attempts;
    }
    await ctx.db.patch("listeningSessions", session._id, {
      status: "reconcile_failed",
      reconcileAttempts: attempts,
      reconcileLeaseUntil: undefined,
      nextReconcileAt: retryAt,
    });
    return attempts;
  },
});

export const deferReconcile = internalMutation({
  args: {
    sessionId: v.id("listeningSessions"),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("listeningSessions", args.sessionId);
    if (!session || session.status === "reconciled") return null;
    await ctx.db.patch("listeningSessions", session._id, {
      reconcileLeaseUntil: undefined,
      nextReconcileAt: args.now + USAGE_UNSETTLED_RETRY_MS,
    });
    return null;
  },
});

export const sweepExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const active = await ctx.db
      .query("listeningSessions")
      .withIndex("by_status_and_expiry", (q) =>
        q.eq("status", "active").lt("keyExpiresAt", now),
      )
      .take(50);
    const reserved = await ctx.db
      .query("listeningSessions")
      .withIndex("by_status_and_expiry", (q) =>
        q.eq("status", "reserved").lt("keyExpiresAt", now),
      )
      .take(50);

    for (const session of [...active, ...reserved]) {
      await expireSession(ctx, session, now);
    }
    return active.length + reserved.length;
  },
});

export const retryPendingFinalization = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("listeningSessions")
      .withIndex("by_next_reconcile", (q) =>
        q.gt("nextReconcileAt", 0).lte("nextReconcileAt", now),
      )
      .take(50);
    let scheduled = 0;
    for (const session of due) {
      await ctx.db.patch("listeningSessions", session._id, {
        nextReconcileAt: now + RECONCILE_LEASE_MS,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.openrouter.finalizeSession,
        { sessionId: session._id },
      );
      scheduled += 1;
    }

    const pendingKeyDeletes = await ctx.db
      .query("listeningSessions")
      .withIndex("by_status_cleanup_and_started", (q) =>
        q
          .eq("status", "reconciled")
          .eq("keyCleanupComplete", false),
      )
      .take(50);
    for (const session of pendingKeyDeletes) {
      await ctx.scheduler.runAfter(
        0,
        internal.openrouter.deleteSessionKey,
        { sessionId: session._id },
      );
      scheduled += 1;
    }
    return scheduled;
  },
});

/** Run once after upgrading a deployment that has sessions from before `nextReconcileAt`. */
export const backfillReconcileSchedule = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    let scheduled = 0;
    for (const status of PENDING_RECONCILE_STATUSES) {
      const sessions = ctx.db
        .query("listeningSessions")
        .withIndex("by_status_and_expiry", (q) => q.eq("status", status));
      for await (const session of sessions) {
        if (session.nextReconcileAt !== undefined) continue;
        await ctx.db.patch("listeningSessions", session._id, {
          nextReconcileAt: now,
        });
        scheduled += 1;
      }
    }
    return scheduled;
  },
});

export const setProductionFreeze = internalMutation({
  args: {
    frozen: v.boolean(),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    frozen: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const reason = args.frozen ? args.reason?.trim() || undefined : undefined;
    const control = await ctx.db
      .query("controlState")
      .withIndex("by_key", (q) => q.eq("key", KILL_SWITCH_KEY))
      .unique();
    if (control) {
      await ctx.db.patch("controlState", control._id, {
        frozen: args.frozen,
        reason,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("controlState", {
        key: KILL_SWITCH_KEY,
        frozen: args.frozen,
        reason,
        updatedAt: now,
      });
    }
    return reason ? { frozen: args.frozen, reason } : { frozen: args.frozen };
  },
});

export const deleteOldReconciled = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("listeningSessions")
      .withIndex("by_status_cleanup_and_started", (q) =>
        q
          .eq("status", "reconciled")
          .eq("keyCleanupComplete", true)
          .lt("startedAt", cutoff),
      )
      .take(100);
    for (const session of old) {
      await ctx.db.delete("listeningSessions", session._id);
    }
    if (old.length === 100) {
      await ctx.scheduler.runAfter(
        0,
        internal.sessions.deleteOldReconciled,
        {},
      );
    }
    return old.length;
  },
});

function invalidRequest() {
  return managedError(
    "invalid_request",
    "Autovox sent an invalid managed listening request. Update the extension and try again.",
  );
}

function sessionScopes(session: Pick<Session, "trialFunded">): BudgetScope[] {
  return session.trialFunded ? ["production", "trial"] : ["production"];
}

function fitsWindow(
  window: Pick<
    Doc<"budgetWindows">,
    "capMicroUsd" | "consumedMicroUsd" | "reservedMicroUsd"
  >,
  reservedMicroUsd: number,
): boolean {
  return (
    window.consumedMicroUsd + window.reservedMicroUsd + reservedMicroUsd <=
    window.capMicroUsd
  );
}

async function findWindow(
  ctx: MutationCtx,
  scope: BudgetScope,
  windowStart: number,
): Promise<Doc<"budgetWindows"> | null> {
  return await ctx.db
    .query("budgetWindows")
    .withIndex("by_scope_and_window", (q) =>
      q.eq("scope", scope).eq("windowStart", windowStart),
    )
    .unique();
}

async function openWindow(
  ctx: MutationCtx,
  scope: BudgetScope,
  period: { budgetWindowStart: number; budgetWindowEnd: number; now: number },
  capMicroUsd: number,
): Promise<
  Pick<
    Doc<"budgetWindows">,
    "_id" | "capMicroUsd" | "consumedMicroUsd" | "reservedMicroUsd" | "frozen"
  >
> {
  const existing = await findWindow(ctx, scope, period.budgetWindowStart);
  if (existing) return existing;
  const fresh = {
    scope,
    windowStart: period.budgetWindowStart,
    windowEnd: period.budgetWindowEnd,
    capMicroUsd,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
    frozen: false,
    updatedAt: period.now,
  };
  const _id = await ctx.db.insert("budgetWindows", fresh);
  return { _id, ...fresh };
}

async function scheduleFinalization(
  ctx: MutationCtx,
  session: Session,
  now: number,
): Promise<void> {
  await ctx.db.patch("listeningSessions", session._id, {
    nextReconcileAt: firstReconcileAt(session, now),
  });
  await ctx.scheduler.runAfter(0, internal.openrouter.finalizeSession, {
    sessionId: session._id,
  });
}

async function expireSession(
  ctx: MutationCtx,
  session: Session,
  now: number,
): Promise<void> {
  await ctx.db.patch("listeningSessions", session._id, {
    status: "expired",
    outcome: "expired",
    faultStage: "none",
    reservationOpen: false,
    endedAt: now,
  });
  await scheduleFinalization(ctx, session, now);
}

async function settleSession(
  ctx: MutationCtx,
  session: Session,
  actualMicroUsd: number,
  costSource: CostSource,
  now: number,
): Promise<void> {
  if (!session.outcome) {
    throw new Error("Cannot reconcile a non-terminal session");
  }
  const balance = await ctx.db
    .query("creditBalances")
    .withIndex("by_account", (q) => q.eq("accountId", session.accountId))
    .unique();
  if (!balance) {
    throw new Error("Account balance is missing");
  }
  const capture = shouldConsumeCredits({
    outcome: session.outcome,
    actualMicroUsd,
  });
  const consumedCredits = capture ? session.reservedCredits : 0;
  await ctx.db.patch("creditBalances", balance._id, {
    reservedCredits: Math.max(
      0,
      balance.reservedCredits - session.reservedCredits,
    ),
    consumedCredits: balance.consumedCredits + consumedCredits,
    updatedAt: now,
  });

  for (const scope of sessionScopes(session)) {
    const window = await findWindow(ctx, scope, session.budgetWindowStart);
    if (!window) {
      throw new Error(`The ${scope} budget window is missing`);
    }
    const consumedMicroUsd = window.consumedMicroUsd + actualMicroUsd;
    const overshoot = !window.frozen && consumedMicroUsd > window.capMicroUsd;
    if (overshoot) {
      console.error(`Freezing the ${scope} budget window for the day`, {
        windowStart: window.windowStart,
        capMicroUsd: window.capMicroUsd,
        consumedMicroUsd,
      });
    }
    await ctx.db.patch("budgetWindows", window._id, {
      consumedMicroUsd,
      reservedMicroUsd: Math.max(
        0,
        window.reservedMicroUsd - session.reservedMicroUsd,
      ),
      ...(overshoot ? { frozen: true, freezeReason: OVERSHOOT_REASON } : {}),
      updatedAt: now,
    });
  }

  await ctx.db.patch("listeningSessions", session._id, {
    status: "reconciled",
    reservationOpen: false,
    actualMicroUsd,
    costSource,
    keyCleanupComplete: !session.openRouterKeyHash,
    reconcileLeaseUntil: undefined,
    nextReconcileAt: undefined,
    reconciledAt: now,
  });
  await ctx.db.insert("creditLedger", {
    accountId: session.accountId,
    idempotencyKey: `settle:${session._id}`,
    kind: capture ? "capture" : "release",
    grantedDelta: 0,
    consumedDelta: consumedCredits,
    reservedDelta: -session.reservedCredits,
    sessionId: session._id,
    createdAt: now,
  });

  const date = utcDay(session.startedAt);
  const metric = await ctx.db
    .query("dailyMetrics")
    .withIndex("by_date", (q) => q.eq("date", date))
    .unique();
  if (!metric) {
    throw new Error("Daily metric row is missing");
  }
  const completed = session.outcome === "completed";
  await ctx.db.patch("dailyMetrics", metric._id, {
    sessionsCompleted: metric.sessionsCompleted + (completed ? 1 : 0),
    sessionsFaulted:
      metric.sessionsFaulted + (session.outcome === "fault" ? 1 : 0),
    sessionsAborted:
      metric.sessionsAborted + (session.outcome === "aborted" ? 1 : 0),
    sessionsExpired:
      metric.sessionsExpired + (session.outcome === "expired" ? 1 : 0),
    providerCostMicroUsd: metric.providerCostMicroUsd + actualMicroUsd,
    reservedMicroUsd: Math.max(
      0,
      metric.reservedMicroUsd - session.reservedMicroUsd,
    ),
    creditsConsumed: metric.creditsConsumed + consumedCredits,
    ...(session.kind === "chalkboard"
      ? {
          chalkboardCompleted:
            (metric.chalkboardCompleted ?? 0) + (completed ? 1 : 0),
          chalkboardProviderCostMicroUsd:
            (metric.chalkboardProviderCostMicroUsd ?? 0) + actualMicroUsd,
          chalkboardCreditsConsumed:
            (metric.chalkboardCreditsConsumed ?? 0) + consumedCredits,
        }
      : {}),
    updatedAt: now,
  });
  if (session.openRouterKeyHash) {
    await ctx.scheduler.runAfter(
      0,
      internal.openrouter.deleteSessionKey,
      { sessionId: session._id },
    );
  }
}

async function releaseReservation(
  ctx: MutationCtx,
  session: Session,
  now: number,
): Promise<void> {
  const balance = await ctx.db
    .query("creditBalances")
    .withIndex("by_account", (q) => q.eq("accountId", session.accountId))
    .unique();
  if (!balance) {
    throw new Error("Cannot release an incomplete reservation");
  }
  await ctx.db.patch("creditBalances", balance._id, {
    reservedCredits: Math.max(
      0,
      balance.reservedCredits - session.reservedCredits,
    ),
    updatedAt: now,
  });
  for (const scope of sessionScopes(session)) {
    const window = await findWindow(ctx, scope, session.budgetWindowStart);
    if (!window) {
      throw new Error("Cannot release an incomplete reservation");
    }
    await ctx.db.patch("budgetWindows", window._id, {
      reservedMicroUsd: Math.max(
        0,
        window.reservedMicroUsd - session.reservedMicroUsd,
      ),
      updatedAt: now,
    });
  }
  await ctx.db.patch("listeningSessions", session._id, {
    status: "provisioning_failed",
    reservationOpen: false,
    endedAt: now,
  });
  await ctx.db.insert("creditLedger", {
    accountId: session.accountId,
    idempotencyKey: `provision-failed:${session._id}`,
    kind: "release",
    grantedDelta: 0,
    consumedDelta: 0,
    reservedDelta: -session.reservedCredits,
    sessionId: session._id,
    createdAt: now,
  });

  const metric = await ctx.db
    .query("dailyMetrics")
    .withIndex("by_date", (q) => q.eq("date", utcDay(session.startedAt)))
    .unique();
  if (metric) {
    await ctx.db.patch("dailyMetrics", metric._id, {
      sessionsFaulted: metric.sessionsFaulted + 1,
      reservedMicroUsd: Math.max(
        0,
        metric.reservedMicroUsd - session.reservedMicroUsd,
      ),
      updatedAt: now,
    });
  }
}
