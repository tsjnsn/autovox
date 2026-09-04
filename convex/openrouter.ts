import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import {
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  MICRO_USD_PER_USD,
  parsePositiveIntegerEnv,
  sessionCapMicroUsd,
  utcDayWindow,
} from "./lib/economics";
import {
  reportLengthValidator,
  sessionKindValidator,
} from "./validators";

const KEY_API = "https://openrouter.ai/api/v1/keys";
const KEY_LIFETIME_MS = 15 * 60 * 1000;
const POLICY_VERSION = "managed-v1";

export const openSession = action({
  args: {
    clientRequestId: v.string(),
    kind: sessionKindValidator,
    reportLength: reportLengthValidator,
    voice: v.string(),
    outputLanguage: v.string(),
    extensionVersion: v.string(),
  },
  returns: v.object({
    sessionId: v.id("listeningSessions"),
    apiKey: v.string(),
    expiresAt: v.number(),
    reservedCredits: v.number(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }
    const managementKey = requireEnv("OPENROUTER_MANAGEMENT_KEY");
    const now = Date.now();
    const expiresAt = now + KEY_LIFETIME_MS;
    const reservedMicroUsd = sessionCapMicroUsd(args.reportLength);
    const dailyBudgetMicroUsd = parsePositiveIntegerEnv(
      process.env.AUTOVOX_DAILY_BUDGET_MICRO_USD,
      DEFAULT_DAILY_BUDGET_MICRO_USD,
    );
    const window = utcDayWindow(now);

    const reservation = await ctx.runMutation(internal.sessions.reserve, {
      tokenIdentifier: identity.tokenIdentifier,
      clientRequestId: args.clientRequestId,
      kind: args.kind,
      reportLength: args.reportLength,
      voice: args.voice,
      outputLanguage: args.outputLanguage,
      extensionVersion: args.extensionVersion,
      policyVersion: POLICY_VERSION,
      now,
      keyExpiresAt: expiresAt,
      reservedMicroUsd,
      budgetWindowStart: window.start,
      budgetWindowEnd: window.end,
      dailyBudgetMicroUsd,
    });

    let keyHash: string | null = null;
    try {
      const body: Record<string, unknown> = {
        name: `autovox-session-${reservation.sessionId}`,
        limit: reservedMicroUsd / MICRO_USD_PER_USD,
        limit_reset: null,
        include_byok_in_limit: true,
        expires_at: new Date(expiresAt).toISOString(),
      };
      const workspaceId = process.env.OPENROUTER_WORKSPACE_ID?.trim();
      if (workspaceId) {
        body.workspace_id = workspaceId;
      }

      const response = await fetch(KEY_API, {
        method: "POST",
        headers: managementHeaders(managementKey),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`OpenRouter key provisioning failed (${response.status})`);
      }
      const payload: unknown = await response.json();
      const parsed = parseCreatedKey(payload);
      keyHash = parsed.hash;

      await ctx.runMutation(internal.sessions.activate, {
        sessionId: reservation.sessionId,
        keyHash: parsed.hash,
      });
      return {
        sessionId: reservation.sessionId,
        apiKey: parsed.key,
        expiresAt,
        reservedCredits: reservation.reservedCredits,
      };
    } catch (error) {
      if (keyHash) {
        await deleteKey(managementKey, keyHash).catch(() => undefined);
      }
      await ctx.runMutation(internal.sessions.failProvisioning, {
        sessionId: reservation.sessionId,
        now: Date.now(),
      });
      throw error;
    }
  },
});

export const finalizeSession = internalAction({
  args: { sessionId: v.id("listeningSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.sessions.getForFinalize, {
      sessionId: args.sessionId,
    });
    if (!session || session.status === "reconciled") return null;

    if (!session.outcome) {
      await ctx.runMutation(internal.sessions.markReconcileFailed, {
        sessionId: args.sessionId,
        now: Date.now(),
      });
      return null;
    }

    if (!session.keyHash) {
      await ctx.runMutation(internal.sessions.settle, {
        sessionId: args.sessionId,
        actualMicroUsd: 0,
        now: Date.now(),
      });
      return null;
    }

    const managementKey = requireEnv("OPENROUTER_MANAGEMENT_KEY");
    try {
      await disableKey(managementKey, session.keyHash);
      const actualMicroUsd = await readKeyUsageMicroUsd(
        managementKey,
        session.keyHash,
      );
      await deleteKey(managementKey, session.keyHash);
      await ctx.runMutation(internal.sessions.settle, {
        sessionId: args.sessionId,
        actualMicroUsd,
        now: Date.now(),
      });
    } catch {
      await ctx.runMutation(internal.sessions.markReconcileFailed, {
        sessionId: args.sessionId,
        now: Date.now(),
      });
    }
    return null;
  },
});

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function managementHeaders(managementKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${managementKey}`,
    "Content-Type": "application/json",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCreatedKey(payload: unknown): { key: string; hash: string } {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const key = root?.key;
  const hash = data?.hash;
  if (
    typeof key !== "string" ||
    !key.startsWith("sk-or-") ||
    typeof hash !== "string" ||
    hash.length < 32
  ) {
    throw new Error("OpenRouter returned an invalid managed key");
  }
  return { key, hash };
}

async function disableKey(
  managementKey: string,
  keyHash: string,
): Promise<void> {
  const response = await fetch(`${KEY_API}/${encodeURIComponent(keyHash)}`, {
    method: "PATCH",
    headers: managementHeaders(managementKey),
    body: JSON.stringify({ disabled: true }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`OpenRouter key disable failed (${response.status})`);
  }
}

async function deleteKey(
  managementKey: string,
  keyHash: string,
): Promise<void> {
  const response = await fetch(`${KEY_API}/${encodeURIComponent(keyHash)}`, {
    method: "DELETE",
    headers: managementHeaders(managementKey),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`OpenRouter key deletion failed (${response.status})`);
  }
}

async function readKeyUsageMicroUsd(
  managementKey: string,
  keyHash: string,
): Promise<number> {
  const response = await fetch(`${KEY_API}/${encodeURIComponent(keyHash)}`, {
    method: "GET",
    headers: managementHeaders(managementKey),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter key usage lookup failed (${response.status})`);
  }
  const payload: unknown = await response.json();
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  const usage = asFiniteNumber(data?.usage) ?? 0;
  const byokUsage = asFiniteNumber(data?.byok_usage) ?? 0;
  return Math.ceil((usage + byokUsage) * MICRO_USD_PER_USD);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}
