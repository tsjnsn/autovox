import type { OverlaySettings } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The overlay's settings view, or null when the background sent nothing
 * usable. Rejects objects that still carry keys.
 */
export function readOverlaySettings(value: unknown): OverlaySettings | null {
  if (!isRecord(value)) return null;
  if ('apiKey' in value || 'openRouterApiKey' in value) return null;
  if (value.providerMode !== 'managed' && value.providerMode !== 'byok') {
    return null;
  }
  if (typeof value.voice !== 'string' || !value.voice) return null;
  if (
    value.reportLength !== 'short' &&
    value.reportLength !== 'standard' &&
    value.reportLength !== 'deep'
  ) {
    return null;
  }
  if (typeof value.outputLanguage !== 'string' || !value.outputLanguage) {
    return null;
  }
  if (typeof value.articleType !== 'string' || !value.articleType) return null;
  if (typeof value.hasAuth !== 'boolean') return null;
  if (typeof value.narrationModel !== 'string') return null;
  return {
    providerMode: value.providerMode,
    voice: value.voice as OverlaySettings['voice'],
    reportLength: value.reportLength,
    outputLanguage: value.outputLanguage as OverlaySettings['outputLanguage'],
    articleType: value.articleType as OverlaySettings['articleType'],
    hasAuth: value.hasAuth,
    narrationModel: value.narrationModel,
  };
}
