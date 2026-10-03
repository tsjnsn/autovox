import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, mutation } from "./_generated/server";
import {
  accountNotInitialized,
  accountSuspended,
  requireIdentity,
} from "./lib/auth";
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
    const identity = await requireIdentity(ctx);

    const now = Date.now();
    const account = await ctx.db
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
      await ctx.db.insert("creditBalances", {
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
      return statusFor(accountId, "user", {
        grantedCredits: TRIAL_CREDITS,
        consumedCredits: 0,
        reservedCredits: 0,
      });
    }

    if (account.status !== "active") {
      throw accountSuspended();
    }

    const balance = await ctx.db
      .query("creditBalances")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .unique();
    if (!balance) {
      throw accountNotInitialized();
    }
    return statusFor(account._id, account.role, balance);
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
      throw accountNotInitialized();
    }
    return statusFor(ctx.account._id, ctx.account.role, balance);
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

function statusFor(
  accountId: Id<"accounts">,
  role: Doc<"accounts">["role"],
  balance: Pick<
    Doc<"creditBalances">,
    "grantedCredits" | "consumedCredits" | "reservedCredits"
  >,
) {
  return {
    accountId,
    role,
    grantedCredits: balance.grantedCredits,
    consumedCredits: balance.consumedCredits,
    reservedCredits: balance.reservedCredits,
    availableCredits: Math.max(
      0,
      balance.grantedCredits -
        balance.consumedCredits -
        balance.reservedCredits,
    ),
  };
}
