export interface DailyEconomics {
  date: string;
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsFaulted: number;
  sessionsAborted: number;
  sessionsExpired: number;
  providerCostMicroUsd: number;
  reservedMicroUsd: number;
  creditsConsumed: number;
  grossRevenueMicroUsd: number;
  confirmedPayments: number;
}

export interface EconomicsSnapshot {
  snapshotVersion: 1;
  sinceDate: string;
  daily: DailyEconomics[];
  budget: {
    windowStart: number;
    windowEnd: number;
    capMicroUsd: number;
    consumedMicroUsd: number;
    reservedMicroUsd: number;
    frozen: boolean;
    freezeReason?: string;
  } | null;
}

export type OperatorObjective =
  | "freeze"
  | "acquire_trials"
  | "improve_paid_conversion"
  | "reduce_fault_waste"
  | "restore_margin"
  | "hold";

export interface OperatorDecision {
  decisionVersion: 1;
  objective: OperatorObjective;
  reason: string;
  evidence: {
    sessionsStarted: number;
    sessionsCompleted: number;
    sessionsFaulted: number;
    sessionsAborted: number;
    confirmedPayments: number;
    grossRevenueMicroUsd: number;
    providerCostMicroUsd: number;
    completionRate: number | null;
    contributionMarginRate: number | null;
  };
  expectedEffect: string;
  allowedPaths: string[];
  constraints: string[];
  action: "stop" | "propose" | "hold";
}

export function evaluateEconomics(
  snapshot: EconomicsSnapshot,
): OperatorDecision {
  const totals = snapshot.daily.reduce(
    (sum, row) => ({
      sessionsStarted: sum.sessionsStarted + row.sessionsStarted,
      sessionsCompleted: sum.sessionsCompleted + row.sessionsCompleted,
      sessionsFaulted: sum.sessionsFaulted + row.sessionsFaulted,
      sessionsAborted: sum.sessionsAborted + row.sessionsAborted,
      confirmedPayments:
        sum.confirmedPayments + row.confirmedPayments,
      grossRevenueMicroUsd:
        sum.grossRevenueMicroUsd + row.grossRevenueMicroUsd,
      providerCostMicroUsd:
        sum.providerCostMicroUsd + row.providerCostMicroUsd,
    }),
    {
      sessionsStarted: 0,
      sessionsCompleted: 0,
      sessionsFaulted: 0,
      sessionsAborted: 0,
      confirmedPayments: 0,
      grossRevenueMicroUsd: 0,
      providerCostMicroUsd: 0,
    },
  );
  const completionRate =
    totals.sessionsStarted > 0
      ? totals.sessionsCompleted / totals.sessionsStarted
      : null;
  const contributionMarginRate =
    totals.grossRevenueMicroUsd > 0
      ? (totals.grossRevenueMicroUsd - totals.providerCostMicroUsd) /
        totals.grossRevenueMicroUsd
      : null;
  const evidence = {
    ...totals,
    completionRate,
    contributionMarginRate,
  };
  const constraints = [
    "one active experiment",
    "no new extension permissions",
    "no new data fields or processors",
    "no page content, URL, title, script, or audio collection",
    "no budget, price, or capital-limit increase",
    "one focused pull request with tests and rollback",
  ];

  if (snapshot.budget?.frozen) {
    return {
      decisionVersion: 1,
      objective: "freeze",
      reason:
        snapshot.budget.freezeReason ??
        "The deterministic budget controller froze managed listening.",
      evidence,
      expectedEffect: "Prevent additional unbounded provider spend.",
      allowedPaths: [],
      constraints,
      action: "stop",
    };
  }

  if (totals.sessionsStarted === 0) {
    return {
      decisionVersion: 1,
      objective: "acquire_trials",
      reason: "No managed trial has started in the measurement window.",
      evidence,
      expectedEffect: "Reach 10 real managed trial starts.",
      allowedPaths: [
        "entrypoints/options/**",
        "README.md",
        "store/listing.md",
      ],
      constraints,
      action: "propose",
    };
  }

  if (
    totals.sessionsStarted >= 10 &&
    totals.confirmedPayments === 0
  ) {
    return {
      decisionVersion: 1,
      objective: "improve_paid_conversion",
      reason:
        "At least 10 funded trials started without one confirmed payment.",
      evidence,
      expectedEffect:
        "Produce the first settled, unrefunded credit-pack purchase.",
      allowedPaths: [
        "entrypoints/options/**",
        "convex/billing.ts",
        "docs/flywheel.md",
        "store/listing.md",
      ],
      constraints,
      action: "propose",
    };
  }

  if (
    totals.sessionsStarted >= 5 &&
    completionRate !== null &&
    completionRate < 0.85
  ) {
    return {
      decisionVersion: 1,
      objective: "reduce_fault_waste",
      reason: "Successful listening is below the 85% reliability floor.",
      evidence,
      expectedEffect:
        "Raise completed listening to at least 85% without increasing cost per completion.",
      allowedPaths: [
        "utils/brief.ts",
        "utils/openai.ts",
        "utils/tts.ts",
        "components/StreamingPlayer.tsx",
        "entrypoints/background.ts",
      ],
      constraints,
      action: "propose",
    };
  }

  if (
    totals.confirmedPayments > 0 &&
    contributionMarginRate !== null &&
    contributionMarginRate < 0.6
  ) {
    return {
      decisionVersion: 1,
      objective: "restore_margin",
      reason: "Contribution margin is below the 60% hard floor.",
      evidence,
      expectedEffect:
        "Restore at least 60% contribution margin without lowering successful listening.",
      allowedPaths: [
        "utils/understand.ts",
        "utils/tts.ts",
        "convex/lib/economics.ts",
      ],
      constraints,
      action: "propose",
    };
  }

  if (totals.confirmedPayments < 10) {
    return {
      decisionVersion: 1,
      objective: "acquire_trials",
      reason: "The first milestone of 10 confirmed payments is not met.",
      evidence,
      expectedEffect: "Reach 10 settled, unrefunded purchases.",
      allowedPaths: [
        "entrypoints/options/**",
        "README.md",
        "store/listing.md",
      ],
      constraints,
      action: "propose",
    };
  }

  return {
    decisionVersion: 1,
    objective: "hold",
    reason:
      "No guardrail is breached and the available evidence does not justify a change.",
    evidence,
    expectedEffect: "Preserve the current profitable behavior.",
    allowedPaths: [],
    constraints,
    action: "hold",
  };
}
