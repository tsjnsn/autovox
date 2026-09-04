import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

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
});

export const snapshot = internalQuery({
  args: { sinceDate: v.string() },
  returns: v.object({
    snapshotVersion: v.literal(1),
    sinceDate: v.string(),
    daily: v.array(dailyMetricValidator),
    budget: v.union(
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
    ),
  }),
  handler: async (ctx, args) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.sinceDate)) {
      throw new Error("sinceDate must be YYYY-MM-DD");
    }
    const rows = await ctx.db
      .query("dailyMetrics")
      .withIndex("by_date", (q) => q.gte("date", args.sinceDate))
      .order("asc")
      .take(60);
    const budget = await ctx.db
      .query("budgetWindows")
      .withIndex("by_scope_and_window", (q) =>
        q.eq("scope", "production"),
      )
      .order("desc")
      .first();

    return {
      snapshotVersion: 1 as const,
      sinceDate: args.sinceDate,
      daily: rows.map((row) => ({
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
      })),
      budget: budget
        ? {
            windowStart: budget.windowStart,
            windowEnd: budget.windowEnd,
            capMicroUsd: budget.capMicroUsd,
            consumedMicroUsd: budget.consumedMicroUsd,
            reservedMicroUsd: budget.reservedMicroUsd,
            frozen: budget.frozen,
            freezeReason: budget.freezeReason,
          }
        : null,
    };
  },
});
