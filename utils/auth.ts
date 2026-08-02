import type { Settings } from './types';

export type LlmAuth =
  | {
      mode: 'openrouter';
      apiKey: string;
      baseUrl: 'https://openrouter.ai/api';
    }
  | {
      mode: 'apiKey';
      apiKey: string;
      baseUrl: 'https://api.openai.com';
    };

const OPENAI_BASE = 'https://api.openai.com' as const;
const OPENROUTER_BASE = 'https://openrouter.ai/api' as const;

export function hasLlmAuth(settings: Settings): boolean {
  return Boolean(settings.openRouterApiKey.trim() || settings.apiKey.trim());
}

/**
 * Prefer OpenRouter Connect over pasted OpenAI API key.
 */
export function resolveLlmAuth(settings: Settings): LlmAuth {
  const openRouterApiKey = settings.openRouterApiKey.trim();
  if (openRouterApiKey) {
    return {
      mode: 'openrouter',
      apiKey: openRouterApiKey,
      baseUrl: OPENROUTER_BASE,
    };
  }

  const apiKey = settings.apiKey.trim();
  if (apiKey) {
    return { mode: 'apiKey', apiKey, baseUrl: OPENAI_BASE };
  }

  throw new Error(
    'Connect with OpenRouter or add an OpenAI API key in Options before briefing.',
  );
}

/** OpenRouter uses provider/model ids. */
export function modelForAuth(auth: LlmAuth, model: string): string {
  if (auth.mode === 'openrouter' && !model.includes('/')) {
    return `openai/${model}`;
  }
  return model;
}

export function authRequestHeaders(auth: LlmAuth): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.apiKey}`,
  };
  if (auth.mode === 'openrouter') {
    headers['X-Title'] = 'Autovox';
  }
  return headers;
}

export function authApiRoot(auth: LlmAuth): string {
  return `${auth.baseUrl}/v1`;
}

/** Stable key for React effects when auth credentials change. */
export function authCacheKey(auth: LlmAuth): string {
  return `${auth.mode}:${auth.apiKey}`;
}
