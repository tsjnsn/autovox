import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

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
    throw new Error("Not authenticated");
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
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_token", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();

  if (!account) {
    throw new Error("Account not initialized");
  }
  if (account.status !== "active") {
    throw new Error("Account is suspended");
  }
  return account;
}
