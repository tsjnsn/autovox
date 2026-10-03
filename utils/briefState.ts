import type { ChalkSceneDrawing } from './chalk/types';
import { finishMoneySession } from './money';
import { normalizePageUrl, samePageUrl } from './pageUrl';
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
  {
    pageUrl: string;
    progress: BriefProgress;
    running: boolean;
    moneySessionId?: string;
  }
>();

const IDLE: BriefProgress = { phase: 'idle', message: 'Idle' };

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

let persistQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialize read-modify-write of the persisted map. Chalkboard scenes finish
 * in parallel, and an unserialized save could drop a sibling scene or revive
 * a cleared brief.
 */
function mutatePersisted<T>(fn: (map: PersistedMap) => T): Promise<T> {
  const run = persistQueue.then(async () => {
    const map = await readPersisted();
    const result = fn(map);
    await writePersisted(map);
    return result;
  });
  persistQueue = run.catch(() => undefined);
  return run;
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
  const existing = liveByTab.get(tabId);
  liveByTab.set(tabId, {
    pageUrl: normalizePageUrl(pageUrl),
    progress,
    running,
    moneySessionId: existing?.moneySessionId,
  });
}

export async function setTabMoneySession(
  tabId: number,
  pageUrl: string,
  moneySessionId: string,
): Promise<void> {
  const existing = liveByTab.get(tabId);
  liveByTab.set(tabId, {
    pageUrl: normalizePageUrl(pageUrl),
    progress: existing?.progress ?? IDLE,
    running: existing?.running ?? true,
    moneySessionId,
  });
}

export async function saveTabBriefResult(
  tabId: number,
  pageUrl: string,
  result: BriefResult,
): Promise<void> {
  const normalized = normalizePageUrl(pageUrl);
  await mutatePersisted((map) => {
    map[tabKey(tabId)] = { pageUrl: normalized, result };
  });

  const live = liveByTab.get(tabId);
  liveByTab.set(tabId, {
    pageUrl: normalized,
    progress: live?.progress ?? {
      phase: 'generating_audio',
      message: 'Generating audio',
    },
    running: live?.running ?? false,
    moneySessionId: live?.moneySessionId ?? result.moneySessionId,
  });
}

/**
 * Store one finished chalkboard scene on the tab's brief so a reopened
 * overlay redraws it without paying for it again. Returns false when the
 * brief it belongs to is gone or was replaced.
 */
export async function saveTabChalkDrawing(
  tabId: number,
  pageUrl: string,
  sessionId: string,
  scene: number,
  drawing: ChalkSceneDrawing,
): Promise<boolean> {
  return await mutatePersisted((map) => {
    const entry = map[tabKey(tabId)];
    if (
      !entry ||
      !samePageUrl(entry.pageUrl, pageUrl) ||
      entry.result.moneySessionId !== sessionId ||
      !entry.result.lesson
    ) {
      return false;
    }
    const drawings = entry.result.lesson.scenes.map(
      (_, index) => entry.result.drawings?.[index] ?? null,
    );
    drawings[scene] = drawing;
    entry.result = { ...entry.result, drawings };
    return true;
  });
}

export async function clearTabBrief(tabId: number): Promise<void> {
  const live = liveByTab.get(tabId);
  liveByTab.delete(tabId);
  const removed = await mutatePersisted((map) => {
    const entry = map[tabKey(tabId)];
    delete map[tabKey(tabId)];
    return entry;
  });
  const sessionId = live?.moneySessionId ?? removed?.result.moneySessionId;
  if (sessionId) {
    await finishMoneySession(sessionId, 'aborted');
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
