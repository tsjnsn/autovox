"use node";

import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action } from "./_generated/server";
import { planKeyValidator } from "./validators";

const stripe = new StripeSubscriptions(components.stripe, {});

export const createCheckout = action({
  args: { productKey: planKeyValidator },
  returns: v.object({
    sessionId: v.string(),
    url: v.string(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }
    if (args.productKey !== "credit_pack_100") {
      throw new Error("This product is not available for checkout");
    }

    const account = await ctx.runQuery(internal.accounts.getByToken, {
      tokenIdentifier: identity.tokenIdentifier,
    });
    if (!account || account.status !== "active") {
      throw new Error("Account not initialized");
    }

    const priceId = requireEnv("STRIPE_PRICE_CREDIT_PACK_100");
    const successUrl = requireEnv("CHECKOUT_SUCCESS_URL");
    const cancelUrl = requireEnv("CHECKOUT_CANCEL_URL");
    const customer = await stripe.getOrCreateCustomer(ctx, {
      userId: identity.subject,
      email: identity.email,
      name: identity.name,
    });
    const checkout = await stripe.createCheckoutSession(ctx, {
      priceId,
      customerId: customer.customerId,
      mode: "payment",
      successUrl,
      cancelUrl,
      metadata: {
        accountId: account.accountId,
        productKey: args.productKey,
      },
      paymentIntentMetadata: {
        accountId: account.accountId,
        productKey: args.productKey,
      },
    });
    if (!checkout.url) {
      throw new Error("Stripe did not return a checkout URL");
    }
    return { sessionId: checkout.sessionId, url: checkout.url };
  },
});

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}
