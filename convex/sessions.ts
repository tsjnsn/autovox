import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { authedMutation } from "./lib/customFunctions";
import { creditsForLength, utcDay } from "./lib/economics";
import {
  faultStageValidator,
  lifecycleEventValidator,
  reportLengthValidator,
  sessionKindValidator,
  sessionOutcomeValidator,
  sessionStatusValidator,
} from "./validators";

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
  },
  returns: v.object({
    sessionId: v.id("listeningSessions"),
    reservedCredits: v.number(),
  }),
  handler: async (ctx, args) => {
    if (!args.clientRequestId.trim()) {
      throw new Error("Client request ID is required");
    }
    if (args.voice.length > 40 || args.outputLanguage.length > 16) {
      throw new Error("Invalid session dimensions");
    }
    if (
      args.reservedMicroUsd <= 0 ||
      args.dailyBudgetMicroUsd <= 0 ||
      args.keyExpiresAt <= args.now
    ) {
      throw new Error("Invalid session budget");
    }

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_token", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();
    if (!account) {
      throw new Error("Account not initialized");
    }
    if (account.status !== "active") {
      throw new Error("Account is suspended");
    }

    let control = await ctx.db
      .query("controlState")
      .withIndex("by_key", (q) => q.eq("key", "production"))
      .unique();
    if (!control) {
      const controlId = await ctx.db.insert("controlState", {
        key: "production",
        frozen: false,
        updatedAt: args.now,
      });
      control = await ctx.db.get("controlState", controlId);
    }
    if (!control) {
      throw new Error("Failed to initialize production controls");
    }
    if (control.frozen) {
      throw new Error(
        control.reason
          ? `Managed listening paused: ${control.reason}`
          : "Managed listening is paused",
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
      throw new Error("This managed request was already used");
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
      const pending = session.reservationOpen;
      if (
        pending &&
        (session.status === "reserved" || session.status === "active") &&
        session.keyExpiresAt <= args.now
      ) {
        await ctx.db.patch("listeningSessions", session._id, {
          status: "expired",
          outcome: "expired",
          faultStage: "none",
          reservationOpen: false,
          endedAt: args.now,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.openrouter.finalizeSession,
          { sessionId: session._id },
        );
        continue;
      }
      if (pending) hasBlockingSession = true;
    }
    if (hasBlockingSession) {
      throw new Error("A managed brief is already in progress");
    }

    const balance = await ctx.db
      .query("creditBalances")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .unique();
    if (!balance) {
      throw new Error("Account balance is missing");
    }
    const reservedCredits = creditsForLength(args.reportLength);
    const available =
      balance.grantedCredits -
      balance.consumedCredits -
      balance.reservedCredits;
    if (available < reservedCredits) {
      throw new Error("No managed brief credits remaining");
    }

    let budget = await ctx.db
      .query("budgetWindows")
      .withIndex("by_scope_and_window", (q) =>
        q
          .eq("scope", "production")
          .eq("windowStart", args.budgetWindowStart),
      )
      .unique();
    if (!budget) {
      const budgetId = await ctx.db.insert("budgetWindows", {
        scope: "production",
        windowStart: args.budgetWindowStart,
        windowEnd: args.budgetWindowEnd,
        capMicroUsd: args.dailyBudgetMicroUsd,
        consumedMicroUsd: 0,
        reservedMicroUsd: 0,
        frozen: false,
        updatedAt: args.now,
      });
      budget = await ctx.db.get("budgetWindows", budgetId);
    }
    if (!budget) {
      throw new Error("Failed to initialize the production budget");
    }
    if (budget.frozen) {
      throw new Error(
        budget.freezeReason
          ? `Managed listening paused: ${budget.freezeReason}`
          : "Managed listening is paused",
      );
    }
    if (
      budget.consumedMicroUsd +
        budget.reservedMicroUsd +
        args.reservedMicroUsd >
      budget.capMicroUsd
    ) {
      throw new Error("Managed listening daily budget reached");
    }

    await ctx.db.patch("creditBalances", balance._id, {
      reservedCredits: balance.reservedCredits + reservedCredits,
      updatedAt: args.now,
    });
    await ctx.db.patch("budgetWindows", budget._id, {
      reservedMicroUsd:
        budget.reservedMicroUsd + args.reservedMicroUsd,
      updatedAt: args.now,
    });

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
    const metric = await ctx.db
      .query("dailyMetrics")
      .withIndex("by_date", (q) => q.eq("date", date))
      .unique();
    if (metric) {
      await ctx.db.patch("dailyMetrics", metric._id, {
        sessionsStarted: metric.sessionsStarted + 1,
        reservedMicroUsd:
          metric.reservedMicroUsd + args.reservedMicroUsd,
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

    await releaseReservation(ctx, session, args.now, "provisioning_failed");
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
      throw new Error("Listening session not found");
    }
    if (session.accountId !== ctx.account._id) {
      throw new Error("Unauthorized listening session");
    }

    const now = Date.now();
    switch (args.event.type) {
      case "script_ready": {
        if (session.status !== "active") return false;
        if (
          args.event.estimatedSeconds <= 0 ||
          args.event.estimatedSeconds > 3_600
        ) {
          throw new Error("Invalid estimated duration");
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
          args.event.playbackSeconds < 0 ||
          args.event.playbackSeconds > 24 * 60 * 60
        ) {
          throw new Error("Invalid playback duration");
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
        await ctx.scheduler.runAfter(
          0,
          internal.openrouter.finalizeSession,
          { sessionId: session._id },
        );
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
    if (!session.outcome) {
      throw new Error("Cannot reconcile a non-terminal session");
    }
    if (
      !Number.isSafeInteger(args.actualMicroUsd) ||
      args.actualMicroUsd < 0
    ) {
      throw new Error("Invalid provider cost");
    }

    const balance = await ctx.db
      .query("creditBalances")
      .withIndex("by_account", (q) =>
        q.eq("accountId", session.accountId),
      )
      .unique();
    if (!balance) {
      throw new Error("Account balance is missing");
    }
    const shouldConsumeCredits =
      session.outcome === "completed" || args.actualMicroUsd > 0;
    await ctx.db.patch("creditBalances", balance._id, {
      reservedCredits: Math.max(
        0,
        balance.reservedCredits - session.reservedCredits,
      ),
      consumedCredits:
        balance.consumedCredits +
        (shouldConsumeCredits ? session.reservedCredits : 0),
      updatedAt: args.now,
    });

    const budget = await ctx.db
      .query("budgetWindows")
      .withIndex("by_scope_and_window", (q) =>
        q
          .eq("scope", "production")
          .eq("windowStart", session.budgetWindowStart),
      )
      .unique();
    if (!budget) {
      throw new Error("Production budget window is missing");
    }
    const nextConsumed = budget.consumedMicroUsd + args.actualMicroUsd;
    await ctx.db.patch("budgetWindows", budget._id, {
      consumedMicroUsd: nextConsumed,
      reservedMicroUsd: Math.max(
        0,
        budget.reservedMicroUsd - session.reservedMicroUsd,
      ),
      frozen: budget.frozen || nextConsumed > budget.capMicroUsd,
      freezeReason:
        nextConsumed > budget.capMicroUsd
          ? "Provider spend exceeded the hard daily cap"
          : budget.freezeReason,
      updatedAt: args.now,
    });
    if (nextConsumed > budget.capMicroUsd) {
      await freezeControl(
        ctx,
        "Provider spend exceeded the hard daily cap",
        args.now,
      );
    }

    await ctx.db.patch("listeningSessions", session._id, {
      status: "reconciled",
      reservationOpen: false,
      actualMicroUsd: args.actualMicroUsd,
      keyCleanupComplete: !session.openRouterKeyHash,
      reconcileLeaseUntil: undefined,
      reconciledAt: args.now,
    });
    await ctx.db.insert("creditLedger", {
      accountId: session.accountId,
      idempotencyKey: `settle:${session._id}`,
      kind: shouldConsumeCredits ? "capture" : "release",
      grantedDelta: 0,
      consumedDelta: shouldConsumeCredits ? session.reservedCredits : 0,
      reservedDelta: -session.reservedCredits,
      sessionId: session._id,
      createdAt: args.now,
    });

    const date = utcDay(session.startedAt);
    const metric = await ctx.db
      .query("dailyMetrics")
      .withIndex("by_date", (q) => q.eq("date", date))
      .unique();
    if (!metric) {
      throw new Error("Daily metric row is missing");
    }
    await ctx.db.patch("dailyMetrics", metric._id, {
      sessionsCompleted:
        metric.sessionsCompleted +
        (session.outcome === "completed" ? 1 : 0),
      sessionsFaulted:
        metric.sessionsFaulted + (session.outcome === "fault" ? 1 : 0),
      sessionsAborted:
        metric.sessionsAborted + (session.outcome === "aborted" ? 1 : 0),
      sessionsExpired:
        metric.sessionsExpired + (session.outcome === "expired" ? 1 : 0),
      providerCostMicroUsd:
        metric.providerCostMicroUsd + args.actualMicroUsd,
      reservedMicroUsd: Math.max(
        0,
        metric.reservedMicroUsd - session.reservedMicroUsd,
      ),
      creditsConsumed:
        metric.creditsConsumed +
        (shouldConsumeCredits ? session.reservedCredits : 0),
      updatedAt: args.now,
    });
    if (session.openRouterKeyHash) {
      await ctx.scheduler.runAfter(
        0,
        internal.openrouter.deleteSessionKey,
        { sessionId: session._id },
      );
    }
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
    await ctx.db.patch("listeningSessions", session._id, {
      status: "reconcile_failed",
      reconcileAttempts: attempts,
      reconcileLeaseUntil: undefined,
    });
    if (attempts < 3) {
      await ctx.scheduler.runAfter(
        5 * 60 * 1000,
        internal.openrouter.finalizeSession,
        { sessionId: session._id },
      );
    } else {
      const budget = await ctx.db
        .query("budgetWindows")
        .withIndex("by_scope_and_window", (q) =>
          q
            .eq("scope", "production")
            .eq("windowStart", session.budgetWindowStart),
        )
        .unique();
      if (budget) {
        await ctx.db.patch("budgetWindows", budget._id, {
          frozen: true,
          freezeReason: "Provider usage reconciliation failed three times",
          updatedAt: args.now,
        });
      }
      await freezeControl(
        ctx,
        "Provider usage reconciliation failed three times",
        args.now,
      );
    }
    return attempts;
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
      await ctx.db.patch("listeningSessions", session._id, {
        status: "expired",
        outcome: "expired",
        faultStage: "none",
        reservationOpen: false,
        endedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.openrouter.finalizeSession,
        { sessionId: session._id },
      );
    }
    return active.length + reserved.length;
  },
});

export const retryPendingFinalization = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    const statuses = [
      "completed",
      "fault",
      "aborted",
      "expired",
      "reconcile_failed",
    ] as const;
    let scheduled = 0;
    for (const status of statuses) {
      const sessions = await ctx.db
        .query("listeningSessions")
        .withIndex("by_status_and_expiry", (q) =>
          q.eq("status", status).lt("keyExpiresAt", cutoff),
        )
        .take(20);
      for (const session of sessions) {
        await ctx.scheduler.runAfter(
          0,
          internal.openrouter.finalizeSession,
          { sessionId: session._id },
        );
        scheduled += 1;
      }
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

async function releaseReservation(
  ctx: MutationCtx,
  session: {
    _id: Id<"listeningSessions">;
    accountId: Id<"accounts">;
    reservedCredits: number;
    reservedMicroUsd: number;
    budgetWindowStart: number;
    startedAt: number;
  },
  now: number,
  status: "provisioning_failed",
): Promise<void> {
  const balance = await ctx.db
    .query("creditBalances")
    .withIndex("by_account", (q) => q.eq("accountId", session.accountId))
    .unique();
  const budget = await ctx.db
    .query("budgetWindows")
    .withIndex("by_scope_and_window", (q) =>
      q
        .eq("scope", "production")
        .eq("windowStart", session.budgetWindowStart),
    )
    .unique();
  if (!balance || !budget) {
    throw new Error("Cannot release an incomplete reservation");
  }
  await ctx.db.patch("creditBalances", balance._id, {
    reservedCredits: Math.max(
      0,
      balance.reservedCredits - session.reservedCredits,
    ),
    updatedAt: now,
  });
  await ctx.db.patch("budgetWindows", budget._id, {
    reservedMicroUsd: Math.max(
      0,
      budget.reservedMicroUsd - session.reservedMicroUsd,
    ),
    updatedAt: now,
  });
  await ctx.db.patch("listeningSessions", session._id, {
    status,
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

async function freezeControl(
  ctx: MutationCtx,
  reason: string,
  now: number,
): Promise<void> {
  const control = await ctx.db
    .query("controlState")
    .withIndex("by_key", (q) => q.eq("key", "production"))
    .unique();
  if (control) {
    await ctx.db.patch("controlState", control._id, {
      frozen: true,
      reason,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.insert("controlState", {
    key: "production",
    frozen: true,
    reason,
    updatedAt: now,
  });
}
