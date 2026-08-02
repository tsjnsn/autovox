import {
  coerceVoice,
  DEFAULT_SETTINGS,
  type BriefResult,
  type Settings,
} from './types';

const SETTINGS_KEY = 'autovoxSettings';
const BRIEF_RESULT_KEY = 'autovoxBriefResult';

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

export async function getBriefResult(): Promise<BriefResult | null> {
  const stored = await browser.storage.session.get(BRIEF_RESULT_KEY);
  return (stored[BRIEF_RESULT_KEY] as BriefResult | undefined) ?? null;
}

export async function saveBriefResult(result: BriefResult): Promise<void> {
  await browser.storage.session.set({ [BRIEF_RESULT_KEY]: result });
}

export async function clearBriefResult(): Promise<void> {
  await browser.storage.session.remove(BRIEF_RESULT_KEY);
}
