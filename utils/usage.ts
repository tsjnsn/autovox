import type { LlmAuth } from './auth';
import { authApiRoot, authRequestHeaders } from './auth';

/** Token and dollar usage from a provider call. Never includes page content. */
export type ProviderUsage = {
  costUsd: number | null;
  costKnown: boolean;
  generationId?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export function emptyUsage(): ProviderUsage {
  return { costUsd: null, costKnown: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asOptionalInt(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  if (n === null) return undefined;
  return Math.round(n);
}

/**
 * Pull cost / tokens / generation id from an OpenRouter or OpenAI JSON body
 * (Responses, Chat Completions, or a single SSE event).
 */
export function parseProviderUsage(data: unknown): ProviderUsage {
  const root = asRecord(data);
  if (!root) return emptyUsage();

  const usage = asRecord(root.usage);
  const generationId =
    (typeof root.id === 'string' && root.id.trim() ? root.id.trim() : undefined) ??
    (typeof root.generation_id === 'string' && root.generation_id.trim()
      ? root.generation_id.trim()
      : undefined);

  const costUsd =
    asFiniteNumber(usage?.cost) ??
    asFiniteNumber(usage?.total_cost) ??
    asFiniteNumber(root.total_cost);

  const inputTokens =
    asOptionalInt(usage?.input_tokens) ?? asOptionalInt(usage?.prompt_tokens);
  const outputTokens =
    asOptionalInt(usage?.output_tokens) ??
    asOptionalInt(usage?.completion_tokens);

  return {
    costUsd,
    costKnown: costUsd !== null,
    generationId,
    inputTokens,
    outputTokens,
  };
}

function mergeUsage(base: ProviderUsage, next: ProviderUsage): ProviderUsage {
  return {
    costUsd: next.costKnown ? next.costUsd : base.costUsd,
    costKnown: next.costKnown || base.costKnown,
    generationId: next.generationId ?? base.generationId,
    inputTokens: next.inputTokens ?? base.inputTokens,
    outputTokens: next.outputTokens ?? base.outputTokens,
  };
}

function parseGenerationPayload(data: unknown): ProviderUsage {
  const root = asRecord(data);
  const inner = asRecord(root?.data) ?? root;
  if (!inner) return emptyUsage();

  const costUsd =
    asFiniteNumber(inner.total_cost) ??
    asFiniteNumber(inner.usage) ??
    asFiniteNumber(asRecord(inner.usage)?.cost);

  const generationId =
    typeof inner.id === 'string' && inner.id.trim() ? inner.id.trim() : undefined;

  return {
    costUsd,
    costKnown: costUsd !== null,
    generationId,
    inputTokens:
      asOptionalInt(inner.tokens_prompt) ?? asOptionalInt(inner.native_tokens_prompt),
    outputTokens:
      asOptionalInt(inner.tokens_completion) ??
      asOptionalInt(inner.native_tokens_completion),
  };
}

async function fetchOpenRouterGeneration(
  auth: LlmAuth,
  generationId: string,
): Promise<ProviderUsage> {
  const url = `${authApiRoot(auth)}/generation?id=${encodeURIComponent(generationId)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: authRequestHeaders(auth),
  });
  if (!response.ok) return emptyUsage();
  const data: unknown = await response.json();
  return parseGenerationPayload(data);
}

/**
 * If the response omitted USD (common right after a stream), ask OpenRouter
 * for the generation. OpenAI native keys have no dollar field — leave unknown.
 */
export async function fillUsageCost(
  auth: LlmAuth,
  usage: ProviderUsage,
): Promise<ProviderUsage> {
  if (usage.costKnown || auth.mode !== 'openrouter' || !usage.generationId) {
    return usage;
  }

  const first = await fetchOpenRouterGeneration(auth, usage.generationId);
  if (first.costKnown) return mergeUsage(usage, first);

  await new Promise((resolve) => setTimeout(resolve, 400));
  const retry = await fetchOpenRouterGeneration(auth, usage.generationId);
  return mergeUsage(usage, retry);
}

export function mergeStreamUsage(
  current: ProviderUsage,
  event: unknown,
): ProviderUsage {
  return mergeUsage(current, parseProviderUsage(event));
}
