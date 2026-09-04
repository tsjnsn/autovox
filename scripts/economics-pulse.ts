import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateEconomics,
  type EconomicsSnapshot,
  type OperatorDecision,
} from "./lib/operator";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_PATH = resolve(ROOT, "store/economics.json");
const MARKDOWN_PATH = resolve(ROOT, "store/decision.md");

interface EconomicsPulse {
  fetchedAt: string;
  status: "ok" | "unconfigured" | "error";
  note: string;
  snapshot: EconomicsSnapshot | null;
  decision: OperatorDecision;
}

const emptySnapshot: EconomicsSnapshot = {
  snapshotVersion: 1,
  sinceDate: new Date().toISOString().slice(0, 10),
  daily: [],
  budget: null,
};

const siteUrl =
  process.env.AUTOVOX_CONTROL_PLANE_SITE_URL?.trim().replace(/\/$/, "") ??
  "";
const operatorSecret = process.env.AUTOVOX_OPERATOR_SECRET?.trim() ?? "";

let pulse: EconomicsPulse;
if (!siteUrl || !operatorSecret) {
  pulse = {
    fetchedAt: new Date().toISOString(),
    status: "unconfigured",
    note: "Set AUTOVOX_CONTROL_PLANE_SITE_URL and AUTOVOX_OPERATOR_SECRET after the managed control plane is deployed.",
    snapshot: null,
    decision: unavailableDecision(
      "hold",
      "The managed control plane is not configured, so there is no economic evidence.",
    ),
  };
} else {
  pulse = await fetchPulse(siteUrl, operatorSecret);
}

const previous = readExisting();
const changed =
  !previous ||
  JSON.stringify(withoutFetchedAt(previous)) !==
    JSON.stringify(withoutFetchedAt(pulse));

mkdirSync(dirname(JSON_PATH), { recursive: true });
if (changed || !previous) {
  writeFileSync(JSON_PATH, `${JSON.stringify(pulse, null, 2)}\n`);
  writeFileSync(MARKDOWN_PATH, renderDecision(pulse));
}

console.log(`status=${pulse.status}`);
console.log(`decision=${pulse.decision.objective}`);
console.log(`changed=${changed}`);

async function fetchPulse(
  baseUrl: string,
  secret: string,
): Promise<EconomicsPulse> {
  try {
    const response = await fetch(`${baseUrl}/operator/snapshot`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) {
      return {
        fetchedAt: new Date().toISOString(),
        status: "error",
        note: `Control plane returned HTTP ${response.status}.`,
        snapshot: null,
        decision: unavailableDecision(
          "stop",
          "Economic truth is unavailable; do not spend or ship.",
        ),
      };
    }
    const payload: unknown = await response.json();
    if (!isEconomicsSnapshot(payload)) {
      throw new Error("Control plane returned an invalid economics snapshot");
    }
    return {
      fetchedAt: new Date().toISOString(),
      status: "ok",
      note: "Aggregated revenue, provider cost, and listening outcomes. No page content or account identifiers.",
      snapshot: payload,
      decision: evaluateEconomics(payload),
    };
  } catch (error) {
    return {
      fetchedAt: new Date().toISOString(),
      status: "error",
      note:
        error instanceof Error
          ? error.message
          : "Failed to fetch the economics snapshot.",
      snapshot: null,
      decision: unavailableDecision(
        "stop",
        "Economic truth is unavailable; do not spend or ship.",
      ),
    };
  }
}

function unavailableDecision(
  action: "hold" | "stop",
  reason: string,
): OperatorDecision {
  const base = evaluateEconomics(emptySnapshot);
  return {
    ...base,
    objective: action === "stop" ? "freeze" : "hold",
    reason,
    expectedEffect:
      action === "stop"
        ? "Prevent decisions without reconciled economics."
        : "Wait for the revenue rail to be configured.",
    allowedPaths: [],
    action,
  };
}

function readExisting(): EconomicsPulse | null {
  try {
    return JSON.parse(readFileSync(JSON_PATH, "utf8")) as EconomicsPulse;
  } catch {
    return null;
  }
}

function withoutFetchedAt(
  value: EconomicsPulse,
): Omit<EconomicsPulse, "fetchedAt"> {
  const { fetchedAt: _fetchedAt, ...rest } = value;
  return rest;
}

function renderDecision(pulse: EconomicsPulse): string {
  const evidence = pulse.decision.evidence;
  const allowed =
    pulse.decision.allowedPaths.length > 0
      ? pulse.decision.allowedPaths.map((path) => `- \`${path}\``).join("\n")
      : "- _No code paths authorized._";
  return `# Autovox operator decision

Fetched **${pulse.fetchedAt}**. Status: **${pulse.status}**.

## Decision: ${pulse.decision.objective}

${pulse.decision.reason}

Expected effect: ${pulse.decision.expectedEffect}

| Economic signal | Value |
| --- | ---: |
| Managed starts | ${evidence.sessionsStarted} |
| Completed listens | ${evidence.sessionsCompleted} |
| Faults | ${evidence.sessionsFaulted} |
| Confirmed payments | ${evidence.confirmedPayments} |
| Gross revenue | ${formatMicroUsd(evidence.grossRevenueMicroUsd)} |
| Provider cost | ${formatMicroUsd(evidence.providerCostMicroUsd)} |
| Completion rate | ${formatRate(evidence.completionRate)} |
| Contribution margin | ${formatRate(evidence.contributionMarginRate)} |

## Authorized paths

${allowed}

## Fixed constraints

${pulse.decision.constraints.map((rule) => `- ${rule}`).join("\n")}

The operator may propose one focused PR. It may not expand these bounds.
`;
}

function formatMicroUsd(value: number): string {
  return `$${(value / 1_000_000).toFixed(2)}`;
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isEconomicsSnapshot(value: unknown): value is EconomicsSnapshot {
  const root = asRecord(value);
  if (
    !root ||
    root.snapshotVersion !== 1 ||
    typeof root.sinceDate !== "string" ||
    !Array.isArray(root.daily)
  ) {
    return false;
  }
  const dailyValid = root.daily.every((row) => {
    const record = asRecord(row);
    return (
      record !== null &&
      typeof record.date === "string" &&
      [
        record.sessionsStarted,
        record.sessionsCompleted,
        record.sessionsFaulted,
        record.sessionsAborted,
        record.sessionsExpired,
        record.providerCostMicroUsd,
        record.reservedMicroUsd,
        record.creditsConsumed,
        record.grossRevenueMicroUsd,
        record.confirmedPayments,
      ].every(isNumber)
    );
  });
  if (!dailyValid) return false;
  if (root.budget === null) return true;
  const budget = asRecord(root.budget);
  return (
    budget !== null &&
    isNumber(budget.windowStart) &&
    isNumber(budget.windowEnd) &&
    isNumber(budget.capMicroUsd) &&
    isNumber(budget.consumedMicroUsd) &&
    isNumber(budget.reservedMicroUsd) &&
    typeof budget.frozen === "boolean" &&
    (budget.freezeReason === undefined ||
      typeof budget.freezeReason === "string")
  );
}
