import type { BriefProgress, BriefResult } from './types';

const SESSION_KEY = 'autovoxBriefByTab';

export type TabBriefSnapshot = {
  pageUrl: string;
  progress: BriefProgress;
  result: BriefResult | null;
  running: boolean;
};

type PersistedEntry = {
  pageUrl: string;
  result: BriefResult;
};

type PersistedMap = Record<string, PersistedEntry>;

/** Live progress / running flags — lost when the service worker sleeps. */
const liveByTab = new Map<
  number,
  { pageUrl: string; progress: BriefProgress; running: boolean }
>();

const IDLE: BriefProgress = { phase: 'idle', message: 'Idle' };

/** Strip hash + trailing slash so SPA / URL variants match the same page. */
export function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    const bare = (url.split('#')[0] ?? url).replace(/\/$/, '');
    return bare;
  }
}

export function samePageUrl(a: string, b: string): boolean {
  if (!a || !b) return false;
  return normalizePageUrl(a) === normalizePageUrl(b);
}

function tabKey(tabId: number): string {
  return String(tabId);
}

async function readPersisted(): Promise<PersistedMap> {
  const stored = await browser.storage.session.get(SESSION_KEY);
  const value = stored[SESSION_KEY] as PersistedMap | undefined;
  return value && typeof value === 'object' ? value : {};
}

async function writePersisted(map: PersistedMap): Promise<void> {
  await browser.storage.session.set({ [SESSION_KEY]: map });
}

export async function getTabBrief(
  tabId: number,
  currentUrl?: string,
): Promise<TabBriefSnapshot> {
  const live = liveByTab.get(tabId);
  const persisted = await readPersisted();
  const entry = persisted[tabKey(tabId)];

  const pageUrl =
    (currentUrl ? normalizePageUrl(currentUrl) : undefined) ??
    live?.pageUrl ??
    entry?.pageUrl ??
    '';

  // Stale brief from a previous page in this tab
  if (
    pageUrl &&
    entry?.pageUrl &&
    !samePageUrl(entry.pageUrl, pageUrl)
  ) {
    await clearTabBrief(tabId);
    return {
      pageUrl,
      progress: IDLE,
      result: null,
      running: false,
    };
  }

  if (
    pageUrl &&
    live?.pageUrl &&
    !samePageUrl(live.pageUrl, pageUrl)
  ) {
    liveByTab.delete(tabId);
    return {
      pageUrl,
      progress: IDLE,
      result: null,
      running: false,
    };
  }

  const result =
    entry && (!pageUrl || samePageUrl(entry.pageUrl, pageUrl))
      ? entry.result
      : null;

  return {
    pageUrl: live?.pageUrl ?? entry?.pageUrl ?? pageUrl,
    progress: live?.progress ?? (result ? { phase: 'ready', message: 'Ready' } : IDLE),
    result,
    running: live?.running ?? false,
  };
}

export async function setTabProgress(
  tabId: number,
  pageUrl: string,
  progress: BriefProgress,
  running: boolean,
): Promise<void> {
  liveByTab.set(tabId, {
    pageUrl: normalizePageUrl(pageUrl),
    progress,
    running,
  });
}

export async function saveTabBriefResult(
  tabId: number,
  pageUrl: string,
  result: BriefResult,
): Promise<void> {
  const normalized = normalizePageUrl(pageUrl);
  const map = await readPersisted();
  map[tabKey(tabId)] = { pageUrl: normalized, result };
  await writePersisted(map);

  const live = liveByTab.get(tabId);
  liveByTab.set(tabId, {
    pageUrl: normalized,
    progress: live?.progress ?? {
      phase: 'generating_audio',
      message: 'Generating audio',
    },
    running: live?.running ?? false,
  });
}

export async function clearTabBrief(tabId: number): Promise<void> {
  liveByTab.delete(tabId);
  const map = await readPersisted();
  if (map[tabKey(tabId)]) {
    delete map[tabKey(tabId)];
    await writePersisted(map);
  }
}

/** Drop state when the tab navigates to a different document URL. */
export async function clearTabIfUrlChanged(
  tabId: number,
  nextUrl: string,
): Promise<void> {
  const normalized = normalizePageUrl(nextUrl);
  const live = liveByTab.get(tabId);
  const map = await readPersisted();
  const entry = map[tabKey(tabId)];

  const previous = live?.pageUrl ?? entry?.pageUrl;
  if (!previous) return;
  if (samePageUrl(previous, normalized)) return;

  await clearTabBrief(tabId);
}
