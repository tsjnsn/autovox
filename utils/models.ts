import type { LlmAuth } from './auth';
import type { Settings } from './types';

/** GPT-6 Luna — cost-optimized model for comprehension / rewrite */
export const DEFAULT_COMPREHENSION_MODEL = 'gpt-6-luna';
/** Chat Completions audio model for spoken narration */
export const DEFAULT_TTS_MODEL = 'gpt-audio-mini';

export const MODEL_CATALOG_KEY = 'autovoxModelCatalog';
/** Options page re-fetches the catalog on this interval while open. */
export const MODEL_CATALOG_REFRESH_MS = 10 * 60 * 1000;

export interface ModelOption {
  id: string;
  label: string;
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
  tts: string;
} {
  if (settings.providerMode === 'managed') {
    return {
      comprehension: DEFAULT_COMPREHENSION_MODEL,
      tts: DEFAULT_TTS_MODEL,
    };
  }
  return {
    comprehension: settings.comprehensionModel.trim() || DEFAULT_COMPREHENSION_MODEL,
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

/** OpenRouter `GET /api/v1/models` → models usable for each stage. */
export function parseOpenRouterModels(data: unknown, fetchedAt = Date.now()): ModelCatalog {
  const rows = isRecord(data) && Array.isArray(data.data) ? data.data : [];
  const comprehension: ModelOption[] = [];
  const tts: ModelOption[] = [];

  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id) continue;
    const architecture = isRecord(row.architecture) ? row.architecture : {};
    const input = stringList(architecture.input_modalities);
    const output = stringList(architecture.output_modalities);
    const params = stringList(row.supported_parameters);
    const option = {
      id: row.id,
      label: typeof row.name === 'string' && row.name ? row.name : row.id,
    };

    if (output.includes('audio') && input.includes('text')) {
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
