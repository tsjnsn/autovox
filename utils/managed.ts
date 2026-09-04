import { createClerkClient } from "@clerk/chrome-extension/client";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { LlmAuth } from "./auth";
import type {
  ManagedLifecycleEvent,
  OutputLanguage,
  ReportLength,
  VoiceId,
} from "./types";

const MANAGED_SESSION_PREFIX = "autovoxManagedSession:";

export interface ManagedAccountStatus {
  grantedCredits: number;
  consumedCredits: number;
  reservedCredits: number;
  availableCredits: number;
}

export interface ManagedSession {
  sessionId: string;
  auth: LlmAuth;
  expiresAt: number;
  reservedCredits: number;
}

interface StoredManagedSession {
  apiKey: string;
  expiresAt: number;
}

let clerkPromise: ReturnType<typeof createBackgroundClerk> | null = null;

export function isManagedConfigured(): boolean {
  return (
    import.meta.env.WXT_PUBLIC_MANAGED_ENABLED === "true" &&
    Boolean(import.meta.env.WXT_PUBLIC_CONVEX_URL?.trim()) &&
    Boolean(import.meta.env.WXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim())
  );
}

export function managedPublishableKey(): string | null {
  const value =
    import.meta.env.WXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? "";
  return value || null;
}

export async function ensureManagedAccount(): Promise<ManagedAccountStatus> {
  return await withManagedClient(async (client) => {
    const status = await client.mutation(api.accounts.ensure, {});
    return pickAccountStatus(status);
  });
}

export async function getManagedAccountStatus(): Promise<ManagedAccountStatus> {
  return await withManagedClient(async (client) => {
    const status = await client.query(api.accounts.getStatus, {});
    return pickAccountStatus(status);
  });
}

export async function createManagedCheckout(): Promise<string> {
  return await withManagedClient(async (client) => {
    const checkout = await client.action(api.billing.createCheckout, {
      productKey: "credit_pack_100",
    });
    return checkout.url;
  });
}

export async function openManagedSession(options: {
  kind: "brief" | "tts_replay";
  reportLength: ReportLength;
  voice: VoiceId;
  outputLanguage: OutputLanguage;
}): Promise<ManagedSession> {
  const opened = await withManagedClient(async (client) => {
    return await client.action(api.openrouter.openSession, {
      clientRequestId: crypto.randomUUID(),
      kind: options.kind,
      reportLength: options.reportLength,
      voice: options.voice,
      outputLanguage: options.outputLanguage,
      extensionVersion: browser.runtime.getManifest().version,
    });
  });
  await browser.storage.session.set({
    [managedSessionKey(opened.sessionId)]: {
      apiKey: opened.apiKey,
      expiresAt: opened.expiresAt,
    } satisfies StoredManagedSession,
  });
  return {
    sessionId: opened.sessionId,
    auth: {
      mode: "openrouter",
      apiKey: opened.apiKey,
      baseUrl: "https://openrouter.ai/api",
    },
    expiresAt: opened.expiresAt,
    reservedCredits: opened.reservedCredits,
  };
}

export async function getManagedSessionAuth(
  sessionId: string,
): Promise<LlmAuth | null> {
  const key = managedSessionKey(sessionId);
  const stored = await browser.storage.session.get(key);
  const value = stored[key] as StoredManagedSession | undefined;
  if (
    !value ||
    typeof value.apiKey !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    return null;
  }
  if (value.expiresAt <= Date.now()) {
    await browser.storage.session.remove(key);
    return null;
  }
  return {
    mode: "openrouter",
    apiKey: value.apiKey,
    baseUrl: "https://openrouter.ai/api",
  };
}

export async function reportManagedLifecycle(
  sessionId: string,
  event: ManagedLifecycleEvent,
): Promise<void> {
  const terminal =
    event.type === "completed" ||
    event.type === "fault" ||
    event.type === "aborted";
  try {
    await withManagedClient(async (client) => {
      await client.mutation(api.sessions.reportLifecycle, {
        sessionId,
        event,
      });
    });
  } finally {
    if (terminal) {
      await browser.storage.session.remove(managedSessionKey(sessionId));
    }
  }
}

export async function clearManagedSession(sessionId: string): Promise<void> {
  await browser.storage.session.remove(managedSessionKey(sessionId));
}

async function withManagedClient<T>(
  operation: (client: ConvexHttpClient) => Promise<T>,
): Promise<T> {
  if (!isManagedConfigured()) {
    throw new Error("Managed listening is not configured in this build");
  }
  const token = await getManagedToken();
  if (!token) {
    throw new Error("Sign in to Autovox in Options for managed listening");
  }
  const url = import.meta.env.WXT_PUBLIC_CONVEX_URL.trim();
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return await operation(client);
}

async function getManagedToken(): Promise<string | null> {
  if (!clerkPromise) {
    clerkPromise = createBackgroundClerk();
  }
  const clerk = await clerkPromise;
  if (!clerk.session) return null;
  return await clerk.session.getToken({ template: "convex" });
}

async function createBackgroundClerk() {
  const publishableKey = managedPublishableKey();
  if (!publishableKey) {
    throw new Error("Clerk is not configured in this build");
  }
  return await createClerkClient({
    publishableKey,
    background: true,
  });
}

function managedSessionKey(sessionId: string): string {
  return `${MANAGED_SESSION_PREFIX}${sessionId}`;
}

function pickAccountStatus(value: ManagedAccountStatus): ManagedAccountStatus {
  return {
    grantedCredits: value.grantedCredits,
    consumedCredits: value.consumedCredits,
    reservedCredits: value.reservedCredits,
    availableCredits: value.availableCredits,
  };
}
