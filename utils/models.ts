import type { LlmAuth } from './auth';
import type { Settings } from './types';

/** GPT-6 Luna — cost-optimized model for comprehension / rewrite */
export const DEFAULT_COMPREHENSION_MODEL = 'gpt-6-luna';
/** BYOK chalkboard drawing; Luna writes well but draws cluttered boards. */
export const DEFAULT_DRAWING_MODEL = 'gpt-6-sol';
/** Chat Completions audio model for spoken narration */
export const DEFAULT_TTS_MODEL = 'gpt-audio-mini';

export const MODEL_CATALOG_KEY = 'autovoxModelCatalog';
/** Options page re-fetches the catalog on this interval while open. */
export const MODEL_CATALOG_REFRESH_MS = 10 * 60 * 1000;

export interface ModelOption {
  id: string;
  label: string;
  /** USD per million tokens; OpenRouter lists prices, OpenAI's models API does not. */
  price?: { input: number; output: number };
}

export type QualityLevel = 1 | 2 | 3 | 4 | 5;

/** A shortlisted model for one role, with why it is on the list. */
export interface ModelPick {
  /** OpenRouter-style id; converted to the catalog's id format when matching. */
  id: string;
  tag: string;
  note: string;
  /** Relative quality for this role, shown as a bar. */
  quality: QualityLevel;
}

export type ModelRole = 'writing' | 'drawing' | 'narration';

/**
 * Shortlists per role. Only picks present in the live catalog are shown, so
 * retired models drop out on their own. Picks and wording follow the
 * chalkboard eval (scripts/chalk-eval); notes are user-facing, so they say
 * what a model is good for, not how it scored.
 */
export const MODEL_PICKS: Record<ModelRole, readonly ModelPick[]> = {
  writing: [
    {
      id: 'openai/gpt-6-luna',
      tag: 'Default',
      note: 'Clear, accurate scripts at almost no cost.',
      quality: 3,
    },
    {
      id: 'z-ai/glm-5.3-flash',
      tag: 'Budget',
      note: 'Polished scripts at almost no cost.',
      quality: 4,
    },
    {
      id: 'openai/gpt-6-sol',
      tag: 'Strong',
      note: 'Thorough, well-structured scripts.',
      quality: 4,
    },
    {
      id: 'anthropic/claude-opus-5.5',
      tag: 'Best',
      note: 'The strongest writer, at a higher cost.',
      quality: 5,
    },
    {
      id: 'anthropic/claude-sonnet-5.5',
      tag: 'Balanced',
      note: 'Concise, natural-sounding scripts.',
      quality: 3,
    },
  ],
  drawing: [
    {
      id: 'anthropic/claude-opus-5.5',
      tag: 'Best boards',
      note: 'The cleanest, most readable chalkboards.',
      quality: 5,
    },
    {
      id: 'openai/gpt-6-sol',
      tag: 'Best value',
      note: 'Nearly as good as the best, at about half the cost.',
      quality: 4,
    },
    {
      id: 'google/gemini-3.8-flash',
      tag: 'Budget',
      note: 'Good chalkboards at a low cost.',
      quality: 4,
    },
    {
      id: 'anthropic/claude-sonnet-5.5',
      tag: 'Fast',
      note: 'Draws quickly; quality varies from board to board.',
      quality: 3,
    },
    {
      id: 'openai/gpt-6-luna',
      tag: 'Cheapest',
      note: 'Lowest cost; boards can look cluttered.',
      quality: 1,
    },
  ],
  narration: [
    {
      id: 'openai/gpt-audio-mini',
      tag: 'Default',
      note: 'Clear, natural narration at a low cost.',
      quality: 4,
    },
    {
      id: 'openai/gpt-audio',
      tag: 'Premium',
      note: 'Richer narration at a much higher cost.',
      quality: 5,
    },
  ],
};

export interface ModelChoices {
  recommended: (ModelOption & { tag: string; note: string; quality: QualityLevel })[];
  others: ModelOption[];
}

/** Split a catalog list into available shortlist picks and everything else. */
export function modelChoices(
  source: LlmAuth['mode'],
  options: readonly ModelOption[],
  picks: readonly ModelPick[],
): ModelChoices {
  const byId = new Map(options.map((option) => [option.id, option]));
  const recommended: ModelChoices['recommended'] = [];
  const picked = new Set<string>();
  for (const pick of picks) {
    const id = catalogModelId(source, pick.id);
    const option = byId.get(id);
    if (!option || picked.has(id)) continue;
    picked.add(id);
    recommended.push({ ...option, tag: pick.tag, note: pick.note, quality: pick.quality });
  }
  return {
    recommended,
    others: options.filter((option) => !picked.has(option.id)),
  };
}

/** Case-insensitive match on every word of the query against id or label. */
export function searchModels(
  options: readonly ModelOption[],
  query: string,
): ModelOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((option) => {
    const haystack = `${option.id} ${option.label}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Typical tokens per unit of work, from the chalkboard eval: one report or
 * lesson plan (writing), one five-board lesson (drawing), and ~2.5 minutes of
 * speech (narration; audio output runs ~20 tokens a second).
 */
const TYPICAL_TOKENS: Record<ModelRole, { input: number; output: number }> = {
  writing: { input: 3_000, output: 2_500 },
  drawing: { input: 10_000, output: 8_000 },
  narration: { input: 1_000, output: 3_000 },
};

/** What the cost estimate is per, in the user's terms. */
export const COST_UNIT: Record<ModelRole, string> = {
  writing: 'report',
  drawing: 'chalkboard',
  narration: 'report',
};

/** Estimated USD per report (or chalkboard, for drawing); null when the price is unknown. */
export function estimateCost(role: ModelRole, price: ModelOption['price']): number | null {
  if (!price) return null;
  const tokens = TYPICAL_TOKENS[role];
  return (tokens.input * price.input + tokens.output * price.output) / 1_000_000;
}

/** "~$0.002", "~$0.09", "~$0.20": one significant figure under a cent, two above. */
export function formatCost(usd: number): string {
  if (usd <= 0) return 'free';
  if (usd < 0.001) return '<$0.001';
  const significant = usd < 0.01 ? 1 : 2;
  const decimals = Math.max(2, significant - 1 - Math.floor(Math.log10(usd)));
  return `~$${usd.toFixed(decimals)}`;
}

export interface ModelCatalog {
  source: LlmAuth['mode'];
  fetchedAt: number;
  comprehension: ModelOption[];
  tts: ModelOption[];
}

/**
 * Models a brief actually runs with. Managed listening is pinned to the
 * defaults because the funded workspace only allows those models.
 */
export function activeModels(settings: Settings): {
  comprehension: string;
  drawing: string;
  tts: string;
} {
  if (settings.providerMode === 'managed') {
    return {
      comprehension: DEFAULT_COMPREHENSION_MODEL,
      drawing: DEFAULT_COMPREHENSION_MODEL,
      tts: DEFAULT_TTS_MODEL,
    };
  }
  const comprehension =
    settings.comprehensionModel.trim() || DEFAULT_COMPREHENSION_MODEL;
  return {
    comprehension,
    drawing: settings.drawingModel.trim() || comprehension,
    tts: settings.ttsModel.trim() || DEFAULT_TTS_MODEL,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function byLabel(a: ModelOption, b: ModelOption): number {
  return a.label.localeCompare(b.label);
}

/** OpenRouter prices are USD-per-token strings. */
function perMillion(value: unknown): number | null {
  const usd = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(usd) && usd >= 0 ? usd * 1_000_000 : null;
}

function openRouterPrice(
  pricing: unknown,
  audio: boolean,
): ModelOption['price'] | undefined {
  if (!isRecord(pricing)) return undefined;
  const input = perMillion(pricing.prompt);
  const output = perMillion(audio ? pricing.audio_output ?? pricing.completion : pricing.completion);
  return input === null || output === null ? undefined : { input, output };
}

/** Batch variants are asynchronous and too slow for a live brief. */
const OPENROUTER_BATCH = /:batch$/;

/** OpenRouter `GET /api/v1/models` → models usable for each stage. */
export function parseOpenRouterModels(data: unknown, fetchedAt = Date.now()): ModelCatalog {
  const rows = isRecord(data) && Array.isArray(data.data) ? data.data : [];
  const comprehension: ModelOption[] = [];
  const tts: ModelOption[] = [];

  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id) continue;
    if (OPENROUTER_BATCH.test(row.id)) continue;
    const architecture = isRecord(row.architecture) ? row.architecture : {};
    const input = stringList(architecture.input_modalities);
    const output = stringList(architecture.output_modalities);
    const params = stringList(row.supported_parameters);
    const audio = output.includes('audio') && input.includes('text');
    const price = openRouterPrice(row.pricing, audio);
    const option: ModelOption = {
      id: row.id,
      label: typeof row.name === 'string' && row.name ? row.name : row.id,
      ...(price ? { price } : {}),
    };

    if (audio) {
      tts.push(option);
    } else if (output.includes('text') && params.includes('structured_outputs')) {
      comprehension.push(option);
    }
  }

  return {
    source: 'openrouter',
    fetchedAt,
    comprehension: comprehension.sort(byLabel),
    tts: tts.sort(byLabel),
  };
}

const OPENAI_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;
/** Reasoning models that accept Responses API `reasoning` + json_schema. */
const OPENAI_COMPREHENSION = /^(gpt-([5-9]|\d{2,})([.-]|$)|o\d)/;
const OPENAI_NOT_COMPREHENSION =
  /(audio|realtime|tts|transcribe|image|search|embedding|codex|chat|pro|deep-research|computer-use)/;
const OPENAI_TTS = /^gpt-audio/;

/** OpenAI `GET /v1/models` → models usable for each stage. */
export function parseOpenAIModels(data: unknown, fetchedAt = Date.now()): ModelCatalog {
  const rows = isRecord(data) && Array.isArray(data.data) ? data.data : [];
  const comprehension: ModelOption[] = [];
  const tts: ModelOption[] = [];

  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string') continue;
    const id = row.id;
    if (OPENAI_SNAPSHOT.test(id)) continue;
    if (OPENAI_TTS.test(id) && !id.includes('realtime')) {
      tts.push({ id, label: id });
    } else if (OPENAI_COMPREHENSION.test(id) && !OPENAI_NOT_COMPREHENSION.test(id)) {
      comprehension.push({ id, label: id });
    }
  }

  return {
    source: 'apiKey',
    fetchedAt,
    comprehension: comprehension.sort(byLabel),
    tts: tts.sort(byLabel),
  };
}

export async function fetchModelCatalog(
  auth: LlmAuth,
  signal?: AbortSignal,
): Promise<ModelCatalog> {
  const response = await fetch(`${auth.baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${auth.apiKey}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Could not load models (${response.status})`);
  }
  const data: unknown = await response.json();
  return auth.mode === 'openrouter'
    ? parseOpenRouterModels(data)
    : parseOpenAIModels(data);
}

/**
 * Selected id in the catalog's id format. OpenRouter lists `openai/…` ids;
 * direct OpenAI lists bare ids.
 */
export function catalogModelId(source: LlmAuth['mode'], model: string): string {
  if (source === 'openrouter') {
    return model.includes('/') ? model : `openai/${model}`;
  }
  return model.startsWith('openai/') ? model.slice('openai/'.length) : model;
}

/** Catalog options, always including the current selection. */
export function modelOptions(
  options: ModelOption[],
  selected: string,
): ModelOption[] {
  if (!selected || options.some((option) => option.id === selected)) {
    return options;
  }
  return [{ id: selected, label: `${selected} (not listed)` }, ...options];
}

export async function getCachedModelCatalog(): Promise<ModelCatalog | null> {
  const stored = await browser.storage.local.get(MODEL_CATALOG_KEY);
  const value = stored[MODEL_CATALOG_KEY] as ModelCatalog | undefined;
  return value && Array.isArray(value.comprehension) && Array.isArray(value.tts)
    ? value
    : null;
}

export async function saveModelCatalog(catalog: ModelCatalog): Promise<void> {
  await browser.storage.local.set({ [MODEL_CATALOG_KEY]: catalog });
}
