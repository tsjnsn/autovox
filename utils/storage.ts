import {
  coerceVoice,
  DEFAULT_SETTINGS,
  type Settings,
} from './types';

const SETTINGS_KEY = 'autovoxSettings';

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  const merged = { ...DEFAULT_SETTINGS, ...value };

  return {
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey : '',
    openRouterApiKey:
      typeof merged.openRouterApiKey === 'string' ? merged.openRouterApiKey : '',
    voice: coerceVoice(merged.voice),
    reportLength: merged.reportLength ?? DEFAULT_SETTINGS.reportLength,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}
