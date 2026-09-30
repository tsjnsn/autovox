import type { Settings } from './types';

export type LlmAuth =
  | {
      mode: 'openrouter';
      apiKey: string;
      baseUrl: 'https://openrouter.ai/api';
      /** Autovox-funded session key; only these must route to ZDR endpoints. */
      managed?: true;
    }
  | {
      mode: 'apiKey';
      apiKey: string;
      baseUrl: 'https://api.openai.com';
    };

const OPENAI_BASE = 'https://api.openai.com' as const;
const OPENROUTER_BASE = 'https://openrouter.ai/api' as const;

export function hasLlmAuth(settings: Settings): boolean {
  if (settings.providerMode === 'managed') {
    return (
      import.meta.env.WXT_PUBLIC_MANAGED_ENABLED === 'true' &&
      Boolean(import.meta.env.WXT_PUBLIC_CONVEX_URL?.trim()) &&
      Boolean(import.meta.env.WXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim()) &&
      Boolean(import.meta.env.WXT_PUBLIC_CLERK_FRONTEND_API_URL?.trim())
    );
  }
  return Boolean(settings.openRouterApiKey.trim() || settings.apiKey.trim());
}

/**
 * Prefer OpenRouter Connect over pasted OpenAI API key.
 */
export function resolveLlmAuth(settings: Settings): LlmAuth {
  if (settings.providerMode === 'managed') {
    throw new Error(
      'Managed listening credentials must be requested for each brief.',
    );
  }
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

/** OpenRouter uses provider/model ids; OpenAI uses bare ids. */
export function modelForAuth(auth: LlmAuth, model: string): string {
  if (auth.mode === 'openrouter' && !model.includes('/')) {
    return `openai/${model}`;
  }
  if (auth.mode === 'apiKey' && model.startsWith('openai/')) {
    return model.slice('openai/'.length);
  }
  return model;
}

export function authRequestHeaders(auth: LlmAuth): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.apiKey}`,
  };
  if (auth.mode === 'openrouter') {
    headers['X-Title'] = 'Autovox';
    headers['HTTP-Referer'] =
      'https://github.com/tsjnsn/autovox';
  }
  return headers;
}

/**
 * OpenRouter provider routing preferences. Managed listening requires ZDR;
 * BYOK keys follow the user's own OpenRouter privacy settings and guardrails.
 */
export function openRouterProviderPrefs(
  auth: LlmAuth,
  options: {
    /**
     * Route only to hosts that support every parameter sent. Without it,
     * OpenRouter may pick a host that silently ignores the JSON schema or
     * reasoning effort, which can stall for minutes.
     */
    requireParameters?: boolean;
    /** Prefer the fastest host over the cheapest; matters for models with many hosts. */
    sort?: 'throughput' | 'latency';
  } = {},
):
  | {
      provider: {
        zdr?: true;
        data_collection: 'deny';
        require_parameters?: true;
        sort?: 'throughput' | 'latency';
      };
    }
  | Record<string, never> {
  if (auth.mode !== 'openrouter') return {};
  return {
    provider: {
      ...(auth.managed ? { zdr: true as const } : {}),
      data_collection: 'deny',
      ...(options.requireParameters ? { require_parameters: true as const } : {}),
      ...(options.sort ? { sort: options.sort } : {}),
    },
  };
}

export function authApiRoot(auth: LlmAuth): string {
  return `${auth.baseUrl}/v1`;
}

/** Stable key for React effects when auth credentials change. */
export function authCacheKey(auth: LlmAuth): string {
  return `${auth.mode}:${auth.apiKey}`;
}
