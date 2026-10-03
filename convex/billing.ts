"use node";

import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action } from "./_generated/server";
import {
  accountNotInitialized,
  accountSuspended,
  notAuthenticated,
} from "./lib/auth";
import { requireEnv } from "./lib/env";
import { managedError } from "./lib/errors";
import { planKeyValidator } from "./validators";

const stripe = new StripeSubscriptions(components.stripe, {});

const CHECKOUT_UNAVAILABLE_MESSAGE =
  "Checkout is unavailable right now. Try again in a few minutes.";

export const createCheckout = action({
  args: { productKey: planKeyValidator },
  returns: v.object({
    sessionId: v.string(),
    url: v.string(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw notAuthenticated();
    }
    if (args.productKey !== "credit_pack_100") {
      throw managedError(
        "product_unavailable",
        "That product isn't available for purchase.",
      );
    }

    const account = await ctx.runQuery(internal.accounts.getByToken, {
      tokenIdentifier: identity.tokenIdentifier,
    });
    if (!account) {
      throw accountNotInitialized();
    }
    if (account.status !== "active") {
      throw accountSuspended();
    }

    const priceId = requireEnv("STRIPE_PRICE_CREDIT_PACK_100");
    const successUrl = requireEnv("CHECKOUT_SUCCESS_URL");
    const cancelUrl = requireEnv("CHECKOUT_CANCEL_URL");
    let checkout: { sessionId: string; url: string | null };
    try {
      const customer = await stripe.getOrCreateCustomer(ctx, {
        userId: identity.subject,
        email: identity.email,
        name: identity.name,
      });
      checkout = await stripe.createCheckoutSession(ctx, {
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
    } catch (error) {
      console.error(
        "Stripe checkout creation failed",
        error instanceof Error ? error.message : String(error),
      );
      throw managedError("provider_unavailable", CHECKOUT_UNAVAILABLE_MESSAGE);
    }
    if (!checkout.url) {
      console.error("Stripe did not return a checkout URL");
      throw managedError("provider_unavailable", CHECKOUT_UNAVAILABLE_MESSAGE);
    }
    return { sessionId: checkout.sessionId, url: checkout.url };
  },
});
