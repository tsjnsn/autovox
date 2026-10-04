import { authCacheKey, hasLlmAuth, resolveLlmAuth } from './auth';
import { activeModels } from './models';
import { coerceSettings } from './storage';
import type { OverlaySettings, Settings } from './types';

/** What the page overlay may see of the settings: no keys. */
export function overlaySettings(settings: Settings): OverlaySettings {
  return {
    providerMode: settings.providerMode,
    voice: settings.voice,
    reportLength: settings.reportLength,
    outputLanguage: settings.outputLanguage,
    articleType: settings.articleType,
    hasAuth: hasLlmAuth(settings),
    narrationModel: activeModels(settings).tts,
  };
}

/**
 * Key-free overlay view from stored settings, missing storage, or a failed
 * load. Always a typed object — the overlay must not see `undefined`.
 */
export function overlaySettingsView(stored: unknown): OverlaySettings {
  return overlaySettings(coerceSettings(stored));
}

/** Changes whenever narration would use a different key. Stays in the background. */
export function credentialsKey(settings: Settings): string {
  if (settings.providerMode === 'managed') return 'managed';
  try {
    return authCacheKey(resolveLlmAuth(settings));
  } catch {
    return '';
  }
}
