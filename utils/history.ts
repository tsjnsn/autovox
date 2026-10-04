import type { ChalkLesson, ChalkSceneDrawing, SessionFormat } from './chalk/types';
import type { ArticleType } from './comprehension';
import type { BriefResult, NewsReportScript } from './types';

/** Newest briefs kept on this browser. Older ones drop off the end. */
export const HISTORY_LIMIT = 40;

/**
 * A generated brief or chalkboard, kept so it can be opened again after the
 * tab is gone. This stays in the extension's IndexedDB. It is not sent anywhere.
 */
export interface Artifact {
  id: string;
  createdAt: number;
  updatedAt: number;
  format: SessionFormat;
  headline: string;
  sourceTitle: string;
  siteName: string | null;
  /** The page it was made from, so the list can tell two briefs apart. */
  pageUrl: string;
  script: NewsReportScript;
  lesson: ChalkLesson | null;
  drawings: (ChalkSceneDrawing | null)[] | null;
  articleType: ArticleType | null;
}

export interface HistoryStore {
  get(id: string): Promise<Artifact | undefined>;
  list(): Promise<Artifact[]>;
  put(artifact: Artifact): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Only ordinary web pages are offered as a link from the library. */
export function artifactPageUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** A later save must not erase art that already arrived. */
export function mergeDrawings(
  previous: (ChalkSceneDrawing | null)[] | null,
  next: (ChalkSceneDrawing | null)[] | null,
): (ChalkSceneDrawing | null)[] | null {
  if (!next) return previous;
  if (!previous) return next;
  const length = Math.max(previous.length, next.length);
  return Array.from({ length }, (_, index) => next[index] ?? previous[index] ?? null);
}

/**
 * The viewable part of a finished brief. Server session ids are left out.
 * Returns null when the brief has no local id to file it under.
 */
export function artifactFromBrief(
  result: BriefResult,
  pageUrl: string,
  now: number,
): Artifact | null {
  const id = result.moneySessionId;
  if (!id) return null;
  return {
    id,
    createdAt: now,
    updatedAt: now,
    format: result.format ?? (result.lesson ? 'chalkboard' : 'brief'),
    headline: result.lesson?.title || result.script.headline,
    sourceTitle: result.source.title,
    siteName: result.source.siteName,
    pageUrl,
    script: result.script,
    lesson: result.lesson ?? null,
    drawings: result.drawings ?? null,
    articleType: result.articleType?.type ?? null,
  };
}

export class ArtifactHistory {
  constructor(
    private readonly store: HistoryStore,
    private readonly now: () => number = Date.now,
    private readonly limit = HISTORY_LIMIT,
  ) {}

  async remember(artifact: Artifact): Promise<void> {
    const existing = await this.store.get(artifact.id);
    await this.store.put({
      ...artifact,
      createdAt: existing?.createdAt ?? artifact.createdAt,
      drawings: mergeDrawings(existing?.drawings ?? null, artifact.drawings),
      updatedAt: this.now(),
    });
    await this.trim();
  }

  async saveDrawings(
    id: string,
    drawings: (ChalkSceneDrawing | null)[],
  ): Promise<void> {
    const existing = await this.store.get(id);
    if (!existing) return;
    await this.store.put({
      ...existing,
      drawings: mergeDrawings(existing.drawings, drawings),
      updatedAt: this.now(),
    });
  }

  async get(id: string): Promise<Artifact | null> {
    return (await this.store.get(id)) ?? null;
  }

  async list(): Promise<Artifact[]> {
    const all = await this.store.list();
    return all.sort(
      (a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt,
    );
  }

  async remove(id: string): Promise<void> {
    await this.store.remove(id);
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }

  private async trim(): Promise<void> {
    const all = await this.list();
    const extra = all.slice(this.limit);
    for (const artifact of extra) {
      await this.store.remove(artifact.id);
    }
  }
}

const DB_NAME = 'autovox-library';
const DB_VERSION = 1;
const STORE = 'artifacts';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Extension-origin IndexedDB. Page scripts cannot open it. */
export class IndexedDbHistoryStore implements HistoryStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.db = null;
        reject(request.error ?? new Error('Could not open the library'));
      };
    });
    return this.db;
  }

  async get(id: string): Promise<Artifact | undefined> {
    const db = await this.open();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    return (await requestResult(store.get(id))) as Artifact | undefined;
  }

  async list(): Promise<Artifact[]> {
    const db = await this.open();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    return (await requestResult(store.getAll())) as Artifact[];
  }

  async put(artifact: Artifact): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE).put(artifact);
    await done;
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE).delete(id);
    await done;
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE).clear();
    await done;
  }
}

let active: ArtifactHistory | null = null;

export function artifactHistory(): ArtifactHistory {
  active ??= new ArtifactHistory(new IndexedDbHistoryStore());
  return active;
}

/** Remembers a finished brief. A library failure must not fail the brief. */
export async function rememberBrief(
  result: BriefResult,
  pageUrl: string,
): Promise<void> {
  const artifact = artifactFromBrief(result, pageUrl, Date.now());
  if (!artifact) return;
  try {
    await artifactHistory().remember(artifact);
  } catch (error) {
    console.warn('[autovox] could not save the brief to the library', error);
  }
}

/** Folds finished chalkboard scenes into the library copy of that brief. */
export async function rememberDrawings(
  id: string,
  drawings: (ChalkSceneDrawing | null)[],
): Promise<void> {
  try {
    await artifactHistory().saveDrawings(id, drawings);
  } catch (error) {
    console.warn('[autovox] could not save chalkboard art to the library', error);
  }
}
