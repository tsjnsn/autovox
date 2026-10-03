const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Provider usage can lag; settle only this long after a session key expires. */
export const RECONCILIATION_GRACE_MS = 10 * MINUTE_MS;

/** How long a scheduled finalize may run before the cron may pick the session again. */
export const RECONCILE_LEASE_MS = 10 * MINUTE_MS;

/** Delay before re-reading usage that changed between two reads. Not a failed attempt. */
export const USAGE_UNSETTLED_RETRY_MS = 5 * MINUTE_MS;

/** Delay after the Nth failed attempt. The attempt after the last delay is final. */
export const RECONCILE_BACKOFF_MS = [
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  HOUR_MS,
  4 * HOUR_MS,
  12 * HOUR_MS,
] as const;

export const MAX_RECONCILE_ATTEMPTS = RECONCILE_BACKOFF_MS.length + 1;

type ReconcilableSession = {
  keyExpiresAt: number;
  openRouterKeyHash?: string;
};

/** Earliest time provider usage for the session can be settled. */
export function settleDueAt(session: ReconcilableSession): number {
  return session.openRouterKeyHash
    ? session.keyExpiresAt + RECONCILIATION_GRACE_MS
    : 0;
}

/**
 * When the cron should next pick up a session that just became terminal. A
 * finalize is also scheduled immediately; it settles when settlement is due,
 * so the cron only acts as a fallback until then.
 */
export function firstReconcileAt(
  session: ReconcilableSession,
  now: number,
): number {
  const settleAt = settleDueAt(session);
  return settleAt > now ? settleAt : now + RECONCILE_LEASE_MS;
}

/** Next attempt after `failedAttempts` failures, or null when none remain. */
export function retryReconcileAt(
  session: ReconcilableSession,
  failedAttempts: number,
  now: number,
): number | null {
  const delay = RECONCILE_BACKOFF_MS[failedAttempts - 1];
  if (delay === undefined) return null;
  return Math.max(now + delay, settleDueAt(session));
}
