import { describe, expect, test } from "vitest";
import {
  creditsForSession,
  shouldConsumeCredits,
  type ReportLength,
  type SessionKind,
} from "../../convex/lib/economics";
import {
  firstReconcileAt,
  MAX_RECONCILE_ATTEMPTS,
  RECONCILE_BACKOFF_MS,
  RECONCILE_LEASE_MS,
  RECONCILIATION_GRACE_MS,
  retryReconcileAt,
} from "../../convex/lib/reconciliation";

const MINUTE_MS = 60 * 1000;

describe("creditsForSession", () => {
  const kinds: SessionKind[] = ["brief", "chalkboard", "tts_replay"];
  const lengths: ReportLength[] = ["short", "standard", "deep"];

  test.each(kinds.flatMap((kind) => lengths.map((length) => [kind, length])))(
    "%s %s",
    (kind, length) => {
      expect(
        creditsForSession(kind as SessionKind, length as ReportLength),
      ).toBe(length === "deep" ? 2 : 1);
    },
  );
});

describe("shouldConsumeCredits", () => {
  test("completed sessions always consume", () => {
    expect(shouldConsumeCredits({ outcome: "completed", actualMicroUsd: 0 })).toBe(
      true,
    );
  });

  test("other outcomes consume only when the provider charged", () => {
    for (const outcome of ["fault", "aborted", "expired"] as const) {
      expect(shouldConsumeCredits({ outcome, actualMicroUsd: 0 })).toBe(false);
      expect(shouldConsumeCredits({ outcome, actualMicroUsd: 1 })).toBe(true);
    }
  });
});

describe("reconciliation schedule", () => {
  const now = 1_000 * MINUTE_MS;
  const keyed = { keyExpiresAt: now + 15 * MINUTE_MS, openRouterKeyHash: "h" };

  test("keyed sessions wait for the grace period after key expiry", () => {
    expect(firstReconcileAt(keyed, now)).toBe(
      keyed.keyExpiresAt + RECONCILIATION_GRACE_MS,
    );
  });

  test("keyless sessions fall back to the lease when settled immediately", () => {
    expect(firstReconcileAt({ keyExpiresAt: now - 1 }, now)).toBe(
      now + RECONCILE_LEASE_MS,
    );
  });

  test("failed attempts back off and then run out", () => {
    const settled = { keyExpiresAt: now - 60 * MINUTE_MS, openRouterKeyHash: "h" };
    expect(RECONCILE_BACKOFF_MS.map((_, i) => retryReconcileAt(settled, i + 1, now))).toEqual(
      [5, 15, 60, 240, 720].map((minutes) => now + minutes * MINUTE_MS),
    );
    expect(retryReconcileAt(settled, MAX_RECONCILE_ATTEMPTS, now)).toBeNull();
  });

  test("a retry never runs before settlement is due", () => {
    expect(retryReconcileAt(keyed, 1, now)).toBe(
      keyed.keyExpiresAt + RECONCILIATION_GRACE_MS,
    );
  });
});
