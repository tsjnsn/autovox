import { v } from "convex/values";
import {
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { CREDIT_PACK_CREDITS, utcDay } from "./lib/economics";
import { planKeyValidator } from "./validators";

export const applyCheckout = internalMutation({
  args: {
    providerEventId: v.string(),
    accountId: v.string(),
    stripeObjectId: v.string(),
    productKey: planKeyValidator,
    grossMicroUsd: v.number(),
    currency: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("billingReceipts")
      .withIndex("by_provider_event", (q) =>
        q.eq("providerEventId", args.providerEventId),
      )
      .unique();
    if (duplicate) return false;
    if (args.productKey !== "credit_pack_100") {
      throw new Error("Unknown checkout product");
    }
    if (
      !Number.isSafeInteger(args.grossMicroUsd) ||
      args.grossMicroUsd <= 0
    ) {
      throw new Error("Invalid settled payment amount");
    }

    const accountId = ctx.db.normalizeId("accounts", args.accountId);
    if (!accountId) {
      throw new Error("Checkout account does not exist");
    }
    const account = await ctx.db.get("accounts", accountId);
    if (!account) {
      throw new Error("Checkout account does not exist");
    }
    const balance = await ctx.db
      .query("creditBalances")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique();
    if (!balance) {
      throw new Error("Checkout account balance is missing");
    }

    await ctx.db.insert("billingReceipts", {
      providerEventId: args.providerEventId,
      accountId,
      eventType: "checkout.session.completed",
      stripeObjectId: args.stripeObjectId,
      productKey: args.productKey,
      grossMicroUsd: args.grossMicroUsd,
      currency: args.currency.toLowerCase(),
      createdAt: args.now,
    });
    await ctx.db.patch("creditBalances", balance._id, {
      grantedCredits: balance.grantedCredits + CREDIT_PACK_CREDITS,
      updatedAt: args.now,
    });
    await ctx.db.insert("creditLedger", {
      accountId,
      idempotencyKey: `checkout:${args.providerEventId}`,
      kind: "grant",
      grantedDelta: CREDIT_PACK_CREDITS,
      consumedDelta: 0,
      reservedDelta: 0,
      sourceId: args.stripeObjectId,
      createdAt: args.now,
    });
    await ctx.db.patch("accounts", accountId, { updatedAt: args.now });
    await addRevenueMetric(
      ctx,
      args.now,
      args.grossMicroUsd,
      1,
    );
    return true;
  },
});

export const applyRefund = internalMutation({
  args: {
    providerEventId: v.string(),
    stripeObjectId: v.string(),
    refundMicroUsd: v.number(),
    currency: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("billingReceipts")
      .withIndex("by_provider_event", (q) =>
        q.eq("providerEventId", args.providerEventId),
      )
      .unique();
    if (duplicate) return false;
    if (
      !Number.isSafeInteger(args.refundMicroUsd) ||
      args.refundMicroUsd <= 0
    ) {
      throw new Error("Invalid refund amount");
    }

    const original = await ctx.db
      .query("billingReceipts")
      .withIndex("by_stripe_object", (q) =>
        q.eq("stripeObjectId", args.stripeObjectId),
      )
      .first();
    if (!original || original.eventType !== "checkout.session.completed") {
      throw new Error("Original settled payment was not found");
    }
    const balance = await ctx.db
      .query("creditBalances")
      .withIndex("by_account", (q) =>
        q.eq("accountId", original.accountId),
      )
      .unique();
    if (!balance) {
      throw new Error("Refund account balance is missing");
    }
    const removable = Math.min(
      CREDIT_PACK_CREDITS,
      Math.max(
        0,
        balance.grantedCredits -
          balance.consumedCredits -
          balance.reservedCredits,
      ),
    );

    await ctx.db.insert("billingReceipts", {
      providerEventId: args.providerEventId,
      accountId: original.accountId,
      eventType: "charge.refunded",
      stripeObjectId: args.stripeObjectId,
      productKey: original.productKey,
      grossMicroUsd: -args.refundMicroUsd,
      currency: args.currency.toLowerCase(),
      createdAt: args.now,
    });
    await ctx.db.patch("creditBalances", balance._id, {
      grantedCredits: balance.grantedCredits - removable,
      updatedAt: args.now,
    });
    await ctx.db.insert("creditLedger", {
      accountId: original.accountId,
      idempotencyKey: `refund:${args.providerEventId}`,
      kind: "refund",
      grantedDelta: -removable,
      consumedDelta: 0,
      reservedDelta: 0,
      sourceId: args.stripeObjectId,
      createdAt: args.now,
    });
    await addRevenueMetric(
      ctx,
      args.now,
      -args.refundMicroUsd,
      0,
    );
    return true;
  },
});

async function addRevenueMetric(
  ctx: MutationCtx,
  now: number,
  revenueDelta: number,
  paymentDelta: number,
): Promise<void> {
  const date = utcDay(now);
  const metric = await ctx.db
    .query("dailyMetrics")
    .withIndex("by_date", (q) => q.eq("date", date))
    .unique();
  if (metric) {
    await ctx.db.patch("dailyMetrics", metric._id, {
      grossRevenueMicroUsd:
        metric.grossRevenueMicroUsd + revenueDelta,
      confirmedPayments: metric.confirmedPayments + paymentDelta,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.insert("dailyMetrics", {
    date,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    sessionsFaulted: 0,
    sessionsAborted: 0,
    sessionsExpired: 0,
    providerCostMicroUsd: 0,
    reservedMicroUsd: 0,
    creditsConsumed: 0,
    grossRevenueMicroUsd: revenueDelta,
    confirmedPayments: paymentDelta,
    updatedAt: now,
  });
}
