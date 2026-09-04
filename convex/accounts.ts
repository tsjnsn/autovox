import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import { TRIAL_CREDITS } from "./lib/economics";
import { authedQuery } from "./lib/customFunctions";

const statusReturn = v.object({
  accountId: v.id("accounts"),
  role: v.union(v.literal("user"), v.literal("admin")),
  grantedCredits: v.number(),
  consumedCredits: v.number(),
  reservedCredits: v.number(),
  availableCredits: v.number(),
});

export const ensure = mutation({
  args: {},
  returns: statusReturn,
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const now = Date.now();
    let account = await ctx.db
      .query("accounts")
      .withIndex("by_token", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();

    if (!account) {
      const accountId = await ctx.db.insert("accounts", {
        tokenIdentifier: identity.tokenIdentifier,
        role: "user",
        status: "active",
        trialGranted: true,
        createdAt: now,
        updatedAt: now,
      });
      const balanceId = await ctx.db.insert("creditBalances", {
        accountId,
        grantedCredits: TRIAL_CREDITS,
        consumedCredits: 0,
        reservedCredits: 0,
        updatedAt: now,
      });
      await ctx.db.insert("creditLedger", {
        accountId,
        idempotencyKey: `trial:${accountId}`,
        kind: "grant",
        grantedDelta: TRIAL_CREDITS,
        consumedDelta: 0,
        reservedDelta: 0,
        sourceId: "managed-trial-v1",
        createdAt: now,
      });
      account = await ctx.db.get("accounts", accountId);
      const balance = await ctx.db.get("creditBalances", balanceId);
      if (!account || !balance) {
        throw new Error("Failed to initialize account");
      }
      return {
        accountId,
        role: account.role,
        grantedCredits: balance.grantedCredits,
        consumedCredits: balance.consumedCredits,
        reservedCredits: balance.reservedCredits,
        availableCredits:
          balance.grantedCredits -
          balance.consumedCredits -
          balance.reservedCredits,
      };
    }

    if (account.status !== "active") {
      throw new Error("Account is suspended");
    }

    const balance = await ctx.db
      .query("creditBalances")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .unique();
    if (!balance) {
      throw new Error("Account balance is missing");
    }

    return {
      accountId: account._id,
      role: account.role,
      grantedCredits: balance.grantedCredits,
      consumedCredits: balance.consumedCredits,
      reservedCredits: balance.reservedCredits,
      availableCredits:
        balance.grantedCredits -
        balance.consumedCredits -
        balance.reservedCredits,
    };
  },
});

export const getStatus = authedQuery({
  args: {},
  returns: statusReturn,
  handler: async (ctx) => {
    const balance = await ctx.db
      .query("creditBalances")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.account._id),
      )
      .unique();
    if (!balance) {
      throw new Error("Account balance is missing");
    }
    return {
      accountId: ctx.account._id,
      role: ctx.account.role,
      grantedCredits: balance.grantedCredits,
      consumedCredits: balance.consumedCredits,
      reservedCredits: balance.reservedCredits,
      availableCredits:
        balance.grantedCredits -
        balance.consumedCredits -
        balance.reservedCredits,
    };
  },
});

export const getByToken = internalQuery({
  args: { tokenIdentifier: v.string() },
  returns: v.union(
    v.object({
      accountId: v.id("accounts"),
      role: v.union(v.literal("user"), v.literal("admin")),
      status: v.union(v.literal("active"), v.literal("suspended")),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_token", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();
    return account
      ? {
          accountId: account._id,
          role: account.role,
          status: account.status,
        }
      : null;
  },
});
