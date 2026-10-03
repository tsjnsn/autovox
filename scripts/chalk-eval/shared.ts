import type { ChalkLesson, ChalkSceneDrawing } from '../../utils/chalk/types';
import type { ArticleTypeChoice, ResolvedArticleType } from '../../utils/comprehension';
import type { ReportLength } from '../../utils/types';
import type { ProviderUsage } from '../../utils/usage';
import type { LessonMetrics, SceneMetrics } from './metrics';

export interface Spend {
  costUsd: number;
  /** Calls whose response carried no dollar figure. */
  costUnknownCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface WritingRun {
  model: string;
  rep: number;
  ok: boolean;
  error?: string;
  ms: number;
  spend: Spend;
  lesson?: ChalkLesson;
  /** Absent in runs recorded before article types. */
  articleType?: ResolvedArticleType;
  metrics?: LessonMetrics;
}

export interface ReferenceLesson {
  source: string;
  lesson: ChalkLesson;
  articleType?: ResolvedArticleType;
}

/** What one drawing attempt streamed before it finished, failed, or timed out. */
export interface AttemptStream {
  attempt: number;
  /** Estimated from streamed characters (~4 per token). */
  reasoningTokens: number;
  outputTokens: number;
  firstTokenMs: number | null;
  ms: number;
  error?: string;
}

export interface SceneRun {
  index: number;
  ok: boolean;
  /** Wall time of the successful attempt (or of the last failed one). */
  ms: number;
  attempts: number;
  errors: string[];
  drawing: ChalkSceneDrawing | null;
  metrics?: SceneMetrics;
  streams?: AttemptStream[];
}

export interface DrawingRun {
  model: string;
  rep: number;
  ms: number;
  spend: Spend;
  scenes: SceneRun[];
}

export const DRAW_CRITERIA = ['fidelity', 'clarity', 'composition', 'appeal'] as const;
export const WRITE_CRITERIA = ['accuracy', 'teaching', 'narration', 'drawability'] as const;
export type DrawCriterion = (typeof DRAW_CRITERIA)[number];
export type WriteCriterion = (typeof WRITE_CRITERIA)[number];

/** One judged entry: a board or a lesson plan, keyed by its run index. */
export interface JudgedEntry<C extends string> {
  run: number;
  scores: Record<C, number>;
  /** 1 = best within its call. */
  rank: number;
  note: string;
}

export interface JudgeCall<C extends string> {
  pass: number;
  /** Scene index for drawing calls; absent for writing. */
  scene?: number;
  /** Run indices in the order the judge saw them (A, B, C, …). */
  order: number[];
  entries: JudgedEntry<C>[];
  error?: string;
}

export interface Judging {
  model: string;
  passes: number;
  spend: Spend;
  writing: JudgeCall<WriteCriterion>[];
  drawing: JudgeCall<DrawCriterion>[];
}

export interface EvalResults {
  createdAt: string;
  /** `path` is the captured page file, so a later judge-only run can reread it. */
  page: { title: string; url: string; chars: number; path?: string };
  reportLength: ReportLength;
  /** The writers' article type choice; absent (as infer) in runs recorded before article types. */
  articleTypeChoice?: ArticleTypeChoice;
  writing: WritingRun[];
  reference: ReferenceLesson | null;
  drawing: DrawingRun[];
  judging?: Judging;
  /**
   * OpenRouter list prices (USD per million tokens) at run time. Reported cost
   * is $0 when a provider is billed through the user's own key, so comparisons
   * use tokens × list price instead.
   */
  prices?: Record<string, { input: number; output: number }>;
}

/** Tokens × list price; null when the model's price is unknown. */
export function listPriceUsd(
  spend: Spend,
  price: { input: number; output: number } | undefined,
): number | null {
  if (!price) return null;
  return (spend.inputTokens * price.input + spend.outputTokens * price.output) / 1_000_000;
}

export function emptySpend(): Spend {
  return { costUsd: 0, costUnknownCalls: 0, inputTokens: 0, outputTokens: 0 };
}

export function addUsage(spend: Spend, usage: ProviderUsage): void {
  if (usage.costKnown && usage.costUsd !== null) spend.costUsd += usage.costUsd;
  else spend.costUnknownCalls += 1;
  spend.inputTokens += usage.inputTokens ?? 0;
  spend.outputTokens += usage.outputTokens ?? 0;
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const usd = (value: number) => `$${value.toFixed(4)}`;

export function runName(run: { model: string; rep: number }, reps: number): string {
  return reps > 1 ? `${run.model} · rep ${run.rep}` : run.model;
}

export interface JudgeSummary<C extends string> {
  run: number;
  /** Calls this run was judged in. */
  judged: number;
  /** Scenes the run could not draw; they score 1 and rank last. */
  missing: number;
  criteria: Record<C, number>;
  /** Mean of the criteria, over judged and missing entries alike. */
  overall: number;
  meanRank: number;
}

/**
 * Average each run's judged scores and ranks across calls. A run absent from a
 * call it should have been in (a failed scene) counts as 1 on every criterion
 * and last place, so failures are not rewarded by omission.
 */
export function summarizeJudging<C extends string>(
  calls: readonly JudgeCall<C>[],
  criteria: readonly C[],
  runCount: number,
  expected: (call: JudgeCall<C>) => number[],
): JudgeSummary<C>[] {
  const totals = Array.from({ length: runCount }, (_, run) => ({
    run,
    judged: 0,
    missing: 0,
    sums: Object.fromEntries(criteria.map((c) => [c, 0])) as Record<C, number>,
    rankSum: 0,
  }));
  for (const call of calls) {
    if (call.error) continue;
    const seen = new Set(call.entries.map((entry) => entry.run));
    const size = expected(call).length;
    for (const entry of call.entries) {
      const total = totals[entry.run];
      if (!total) continue;
      total.judged += 1;
      total.rankSum += entry.rank;
      for (const c of criteria) total.sums[c] += entry.scores[c];
    }
    for (const run of expected(call)) {
      if (seen.has(run)) continue;
      const total = totals[run];
      if (!total) continue;
      total.missing += 1;
      total.rankSum += size;
      for (const c of criteria) total.sums[c] += 1;
    }
  }
  return totals
    .filter((total) => total.judged + total.missing > 0)
    .map((total) => {
      const n = total.judged + total.missing;
      const means = Object.fromEntries(
        criteria.map((c) => [c, total.sums[c] / n]),
      ) as Record<C, number>;
      return {
        run: total.run,
        judged: total.judged,
        missing: total.missing,
        criteria: means,
        overall: criteria.reduce((sum, c) => sum + means[c], 0) / criteria.length,
        meanRank: total.rankSum / n,
      };
    })
    .sort((a, b) => b.overall - a.overall);
}
