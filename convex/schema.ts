import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  accountRoleValidator,
  accountStatusValidator,
  faultStageValidator,
  planKeyValidator,
  reportLengthValidator,
  sessionKindValidator,
  sessionOutcomeValidator,
  sessionStatusValidator,
} from "./validators";

export default defineSchema({
  accounts: defineTable({
    tokenIdentifier: v.string(),
    role: accountRoleValidator,
    status: accountStatusValidator,
    trialGranted: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_token", ["tokenIdentifier"]),

  creditBalances: defineTable({
    accountId: v.id("accounts"),
    grantedCredits: v.number(),
    consumedCredits: v.number(),
    reservedCredits: v.number(),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

  creditLedger: defineTable({
    accountId: v.id("accounts"),
    idempotencyKey: v.string(),
    kind: v.union(
      v.literal("grant"),
      v.literal("reserve"),
      v.literal("capture"),
      v.literal("release"),
      v.literal("refund"),
    ),
    grantedDelta: v.number(),
    consumedDelta: v.number(),
    reservedDelta: v.number(),
    sessionId: v.optional(v.id("listeningSessions")),
    sourceId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_account_and_created", ["accountId", "createdAt"]),

  budgetWindows: defineTable({
    scope: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
    capMicroUsd: v.number(),
    consumedMicroUsd: v.number(),
    reservedMicroUsd: v.number(),
    frozen: v.boolean(),
    freezeReason: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_scope_and_window", ["scope", "windowStart"]),

  listeningSessions: defineTable({
    accountId: v.id("accounts"),
    clientRequestId: v.string(),
    kind: sessionKindValidator,
    status: sessionStatusValidator,
    outcome: v.optional(sessionOutcomeValidator),
    faultStage: faultStageValidator,
    reportLength: reportLengthValidator,
    voice: v.string(),
    outputLanguage: v.string(),
    extensionVersion: v.string(),
    policyVersion: v.string(),
    reservedCredits: v.number(),
    reservedMicroUsd: v.number(),
    budgetWindowStart: v.number(),
    actualMicroUsd: v.optional(v.number()),
    openRouterKeyHash: v.optional(v.string()),
    keyExpiresAt: v.number(),
    scriptEstimatedSeconds: v.optional(v.number()),
    playbackStartedAt: v.optional(v.number()),
    playbackSeconds: v.optional(v.number()),
    reconcileAttempts: v.number(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    reconciledAt: v.optional(v.number()),
  })
    .index("by_account_and_client_request", [
      "accountId",
      "clientRequestId",
    ])
    .index("by_account_and_started", ["accountId", "startedAt"])
    .index("by_status_and_expiry", ["status", "keyExpiresAt"]),

  billingReceipts: defineTable({
    providerEventId: v.string(),
    accountId: v.id("accounts"),
    eventType: v.string(),
    stripeObjectId: v.string(),
    productKey: planKeyValidator,
    grossMicroUsd: v.number(),
    currency: v.string(),
    createdAt: v.number(),
  })
    .index("by_provider_event", ["providerEventId"])
    .index("by_stripe_object", ["stripeObjectId"])
    .index("by_account_and_created", ["accountId", "createdAt"]),

  dailyMetrics: defineTable({
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
    updatedAt: v.number(),
  }).index("by_date", ["date"]),
});
