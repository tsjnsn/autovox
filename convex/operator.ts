import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { utcDayWindow } from "./lib/economics";

const dailyMetricValidator = v.object({
  date: v.string(),
  sessionsStarted: v.number(),
  sessionsCompleted: v.number(),
  sessionsFaulted: v.number(),
  sessionsAborted: v.number(),
  sessionsExpired: v.number(),
  providerCostMicroUsd: v.number(),
  reservedMicroUsd: v.number(),
  creditsConsumed: v.number(),
  grossRevenueMicroUsd: v.number(),
  confirmedPayments: v.number(),
  chalkboardStarted: v.optional(v.number()),
  chalkboardCompleted: v.optional(v.number()),
  chalkboardProviderCostMicroUsd: v.optional(v.number()),
  chalkboardCreditsConsumed: v.optional(v.number()),
});

const budgetWindowValidator = v.union(
  v.object({
    windowStart: v.number(),
    windowEnd: v.number(),
    capMicroUsd: v.number(),
    consumedMicroUsd: v.number(),
    reservedMicroUsd: v.number(),
    frozen: v.boolean(),
    freezeReason: v.optional(v.string()),
  }),
  v.null(),
);

export const snapshot = internalQuery({
  args: { sinceDate: v.string(), now: v.number() },
  returns: v.object({
    snapshotVersion: v.literal(2),
    sinceDate: v.string(),
    daily: v.array(dailyMetricValidator),
    killSwitch: v.object({
      frozen: v.boolean(),
      reason: v.optional(v.string()),
    }),
    budget: budgetWindowValidator,
    trialBudget: budgetWindowValidator,
  }),
  handler: async (ctx, args) => {
    const parsed = Date.parse(`${args.sinceDate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(args.sinceDate) ||
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().slice(0, 10) !== args.sinceDate
    ) {
      throw new Error("sinceDate must be YYYY-MM-DD");
    }
    const rows = await ctx.db
      .query("dailyMetrics")
      .withIndex("by_date", (q) => q.gte("date", args.sinceDate))
      .order("desc")
      .take(60);
    const control = await ctx.db
      .query("controlState")
      .withIndex("by_key", (q) => q.eq("key", "production"))
      .unique();
    const windowStart = utcDayWindow(args.now).start;

    return {
      snapshotVersion: 2 as const,
      sinceDate: args.sinceDate,
      daily: rows.reverse().map((row) => ({
        date: row.date,
        sessionsStarted: row.sessionsStarted,
        sessionsCompleted: row.sessionsCompleted,
        sessionsFaulted: row.sessionsFaulted,
        sessionsAborted: row.sessionsAborted,
        sessionsExpired: row.sessionsExpired,
        providerCostMicroUsd: row.providerCostMicroUsd,
        reservedMicroUsd: row.reservedMicroUsd,
        creditsConsumed: row.creditsConsumed,
        grossRevenueMicroUsd: row.grossRevenueMicroUsd,
        confirmedPayments: row.confirmedPayments,
        chalkboardStarted: row.chalkboardStarted,
        chalkboardCompleted: row.chalkboardCompleted,
        chalkboardProviderCostMicroUsd: row.chalkboardProviderCostMicroUsd,
        chalkboardCreditsConsumed: row.chalkboardCreditsConsumed,
      })),
      killSwitch: control?.frozen
        ? { frozen: true, reason: control.reason }
        : { frozen: false },
      budget: await currentWindow(ctx, "production", windowStart),
      trialBudget: await currentWindow(ctx, "trial", windowStart),
    };
  },
});

async function currentWindow(
  ctx: QueryCtx,
  scope: "production" | "trial",
  windowStart: number,
) {
  const window = await ctx.db
    .query("budgetWindows")
    .withIndex("by_scope_and_window", (q) =>
      q.eq("scope", scope).eq("windowStart", windowStart),
    )
    .unique();
  return window
    ? {
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        capMicroUsd: window.capMicroUsd,
        consumedMicroUsd: window.consumedMicroUsd,
        reservedMicroUsd: window.reservedMicroUsd,
        frozen: window.frozen,
        freezeReason: window.freezeReason,
      }
    : null;
}
