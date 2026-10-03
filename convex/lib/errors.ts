import { ConvexError, type Value } from "convex/values";

/**
 * Errors the extension can act on. Convex production deployments replace the
 * message of any plain `Error` with "Server Error", so everything a client
 * branches on or shows a user must be thrown as one of these.
 */
export const MANAGED_ERROR_CODES = [
  "not_authenticated",
  "account_not_initialized",
  "account_suspended",
  /** The kill switch is on, or today's budget window is frozen. */
  "paused",
  "daily_budget_reached",
  "trial_budget_reached",
  "no_credits",
  "session_in_progress",
  "request_reused",
  /** Transient on our side, e.g. the budget window rolls over at midnight UTC. */
  "retry_shortly",
  "invalid_request",
  "not_found",
  "forbidden",
  /** OpenRouter could not provision a session key. */
  "provider_unavailable",
  "product_unavailable",
  "not_configured",
] as const;

export type ManagedErrorCode = (typeof MANAGED_ERROR_CODES)[number];

export type ManagedErrorData = {
  code: ManagedErrorCode;
  /** Safe to show the user as-is. */
  message: string;
};

const CODES = new Set<string>(MANAGED_ERROR_CODES);

export function managedError(
  code: ManagedErrorCode,
  message: string,
): ConvexError<ManagedErrorData> {
  return new ConvexError<ManagedErrorData>({ code, message });
}

/** The structured payload of a managed error, or null for anything else. */
export function managedErrorData(error: unknown): ManagedErrorData | null {
  if (!(error instanceof Error) || error.name !== "ConvexError") return null;
  const data: unknown = (error as ConvexError<Value>).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, message } = data as Record<string, unknown>;
  return typeof code === "string" &&
    CODES.has(code) &&
    typeof message === "string"
    ? { code: code as ManagedErrorCode, message }
    : null;
}
