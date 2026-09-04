import {
  coerceOutputLanguage,
  coerceVoice,
  DEFAULT_SETTINGS,
  type ProviderMode,
  type Settings,
} from './types';

const SETTINGS_KEY = 'autovoxSettings';

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  const merged = { ...DEFAULT_SETTINGS, ...value };
  const configuredDefault: ProviderMode =
    import.meta.env.WXT_PUBLIC_MANAGED_ENABLED === 'true' &&
    !merged.openRouterApiKey?.trim() &&
    !merged.apiKey?.trim()
      ? 'managed'
      : 'byok';
  const providerMode: ProviderMode =
    value?.providerMode === 'managed' || value?.providerMode === 'byok'
      ? value.providerMode
      : configuredDefault;

  return {
    providerMode,
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey : '',
    openRouterApiKey:
      typeof merged.openRouterApiKey === 'string' ? merged.openRouterApiKey : '',
    voice: coerceVoice(merged.voice),
    reportLength: merged.reportLength ?? DEFAULT_SETTINGS.reportLength,
    outputLanguage: coerceOutputLanguage(merged.outputLanguage),
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}
