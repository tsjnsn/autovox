import type { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { managedError, type ManagedErrorData } from "./errors";

export function notAuthenticated(): ConvexError<ManagedErrorData> {
  return managedError(
    "not_authenticated",
    "Sign in to Autovox to use managed listening.",
  );
}

export function accountNotInitialized(): ConvexError<ManagedErrorData> {
  return managedError(
    "account_not_initialized",
    "Your managed account isn't set up yet. Sign in again from Options.",
  );
}

export function accountSuspended(): ConvexError<ManagedErrorData> {
  return managedError(
    "account_suspended",
    "This managed account is suspended. Contact Autovox support.",
  );
}

export async function requireIdentity(
  ctx: QueryCtx | MutationCtx,
): Promise<{
  tokenIdentifier: string;
  subject: string;
  email?: string;
  name?: string;
}> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw notAuthenticated();
  }
  return {
    tokenIdentifier: identity.tokenIdentifier,
    subject: identity.subject,
    email: identity.email,
    name: identity.name,
  };
}

export async function requireAccount(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"accounts">> {
  const identity = await requireIdentity(ctx);
  return await requireActiveAccount(ctx, identity.tokenIdentifier);
}

export async function requireActiveAccount(
  ctx: QueryCtx | MutationCtx,
  tokenIdentifier: string,
): Promise<Doc<"accounts">> {
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
  if (!account) {
    throw accountNotInitialized();
  }
  if (account.status !== "active") {
    throw accountSuspended();
  }
  return account;
}
