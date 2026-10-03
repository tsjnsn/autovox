export const MICRO_USD_PER_USD = 1_000_000;
export const TRIAL_CREDITS = 3;
export const CREDIT_PACK_CREDITS = 100;
export const DEFAULT_DAILY_BUDGET_MICRO_USD = 20 * MICRO_USD_PER_USD;
export const DEFAULT_TRIAL_DAILY_BUDGET_MICRO_USD = 5 * MICRO_USD_PER_USD;

export type ReportLength = "short" | "standard" | "deep";
export type SessionKind = "brief" | "chalkboard" | "tts_replay";
export type SessionOutcome = "completed" | "fault" | "aborted" | "expired";

export function creditsForSession(
  kind: SessionKind,
  reportLength: ReportLength,
): number {
  switch (kind) {
    case "brief":
    case "chalkboard":
    case "tts_replay":
      return reportLength === "deep" ? 2 : 1;
  }
}

export function shouldConsumeCredits(settlement: {
  outcome: SessionOutcome;
  actualMicroUsd: number;
}): boolean {
  return (
    settlement.outcome === "completed" || settlement.actualMicroUsd > 0
  );
}

export function sessionCapMicroUsd(reportLength: ReportLength): number {
  switch (reportLength) {
    case "short":
      return 30_000;
    case "standard":
      return 60_000;
    case "deep":
      return 100_000;
  }
}

export function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function utcDayWindow(timestamp: number): {
  start: number;
  end: number;
} {
  const date = new Date(timestamp);
  const start = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  return { start, end: start + 24 * 60 * 60 * 1000 };
}
