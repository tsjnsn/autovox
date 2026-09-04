import { registerRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

registerRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
  events: {
    "checkout.session.completed": async (ctx, event) => {
      const checkout = event.data.object;
      if (checkout.payment_status !== "paid") return;
      const accountId = checkout.metadata?.accountId;
      const productKey = checkout.metadata?.productKey;
      const paymentIntentId =
        typeof checkout.payment_intent === "string"
          ? checkout.payment_intent
          : checkout.payment_intent?.id;
      if (
        !accountId ||
        productKey !== "credit_pack_100" ||
        !paymentIntentId ||
        checkout.amount_total === null ||
        !checkout.currency
      ) {
        throw new Error("Settled checkout is missing required metadata");
      }
      if (checkout.currency.toLowerCase() !== "usd") {
        throw new Error("Autovox credit packs must settle in USD");
      }
      await ctx.runMutation(internal.billingInternal.applyCheckout, {
        providerEventId: `payment:${paymentIntentId}`,
        accountId,
        stripeObjectId: paymentIntentId,
        productKey,
        grossMicroUsd: checkout.amount_total * 10_000,
        currency: checkout.currency,
        now: event.created * 1000,
      });
    },
    "checkout.session.async_payment_succeeded": async (ctx, event) => {
      const checkout = event.data.object;
      const accountId = checkout.metadata?.accountId;
      const productKey = checkout.metadata?.productKey;
      const paymentIntentId =
        typeof checkout.payment_intent === "string"
          ? checkout.payment_intent
          : checkout.payment_intent?.id;
      if (
        !accountId ||
        productKey !== "credit_pack_100" ||
        !paymentIntentId ||
        checkout.amount_total === null ||
        !checkout.currency
      ) {
        throw new Error("Settled checkout is missing required metadata");
      }
      if (checkout.currency.toLowerCase() !== "usd") {
        throw new Error("Autovox credit packs must settle in USD");
      }
      await ctx.runMutation(internal.billingInternal.applyCheckout, {
        providerEventId: `payment:${paymentIntentId}`,
        accountId,
        stripeObjectId: paymentIntentId,
        productKey,
        grossMicroUsd: checkout.amount_total * 10_000,
        currency: checkout.currency,
        now: event.created * 1000,
      });
    },
    "refund.created": async (ctx, event) => {
      const refund = event.data.object;
      if (refund.status !== "succeeded") return;
      const paymentIntentId =
        typeof refund.payment_intent === "string"
          ? refund.payment_intent
          : refund.payment_intent?.id;
      if (!paymentIntentId || !refund.currency) {
        throw new Error("Refund is missing its payment intent");
      }
      if (refund.currency.toLowerCase() !== "usd") {
        throw new Error("Autovox refunds must settle in USD");
      }
      await ctx.runMutation(internal.billingInternal.applyRefund, {
        providerEventId: `refund:${refund.id}`,
        stripeObjectId: paymentIntentId,
        refundMicroUsd: refund.amount * 10_000,
        currency: refund.currency,
        now: event.created * 1000,
      });
    },
    "refund.updated": async (ctx, event) => {
      const refund = event.data.object;
      if (refund.status !== "succeeded") return;
      const paymentIntentId =
        typeof refund.payment_intent === "string"
          ? refund.payment_intent
          : refund.payment_intent?.id;
      if (!paymentIntentId || !refund.currency) {
        throw new Error("Refund is missing its payment intent");
      }
      if (refund.currency.toLowerCase() !== "usd") {
        throw new Error("Autovox refunds must settle in USD");
      }
      await ctx.runMutation(internal.billingInternal.applyRefund, {
        providerEventId: `refund:${refund.id}`,
        stripeObjectId: paymentIntentId,
        refundMicroUsd: refund.amount * 10_000,
        currency: refund.currency,
        now: event.created * 1000,
      });
    },
  },
});

http.route({
  path: "/checkout/complete",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Autovox credits ready</title>
    <style>
      body{font:16px system-ui,sans-serif;max-width:36rem;margin:5rem auto;padding:0 1.25rem;color:#141414}
      h1{text-transform:uppercase;letter-spacing:.08em}p{line-height:1.5}
    </style>
  </head>
  <body>
    <h1>Credits ready</h1>
    <p>Return to Autovox Options. Your managed balance will update after payment confirmation.</p>
  </body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }),
});

http.route({
  path: "/operator/snapshot",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.AUTOVOX_OPERATOR_SECRET?.trim();
    const supplied = request.headers
      .get("Authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim();
    if (!expected || supplied !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }
    const requestedSince = new URL(request.url).searchParams.get("since");
    const defaultSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const snapshot = await ctx.runQuery(internal.operator.snapshot, {
      sinceDate: requestedSince ?? defaultSince,
    });
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  }),
});

export default http;
