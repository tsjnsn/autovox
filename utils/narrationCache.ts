import { PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE } from './pcmFormat';

/**
 * Bump when the narration request changes shape (the script wrapper, audio
 * format, routing) so audio made the old way stops matching.
 */
export const NARRATION_CACHE_VERSION = 1;

const MINUTE_BYTES = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 60;

/**
 * About 45 minutes of narration: a standard brief is 2–3.5 minutes (~6–10 MB),
 * so the cache holds the last dozen or more briefs and lessons on screen.
 */
export const NARRATION_CACHE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Narration replays only through a brief still saved for its tab, and saved
 * briefs end when the browser restarts (which also clears this cache). A week
 * bounds how long audio outlives a browser that is never restarted.
 */
export const NARRATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Everything that changes the audio a provider returns. */
export interface NarrationKeyInput {
  texts: readonly string[];
  voice: string;
  model: string;
  instructions: string;
  articleType: string | null;
  outputLanguage: string;
  authMode: 'openrouter' | 'apiKey' | 'managed';
}

export async function narrationCacheKey(
  input: NarrationKeyInput,
): Promise<string> {
  const canonical = JSON.stringify([
    NARRATION_CACHE_VERSION,
    input.authMode,
    input.model,
    input.voice,
    input.outputLanguage,
    input.articleType,
    input.instructions,
    input.texts,
  ]);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export interface NarrationCacheEntry {
  key: string;
  bytes: number;
  segments: number;
  createdAt: number;
  lastUsedAt: number;
}

/** Storage the cache policy runs on; IndexedDB in the extension, memory in tests. */
export interface NarrationCacheStore {
  getEntry(key: string): Promise<NarrationCacheEntry | undefined>;
  listEntries(): Promise<NarrationCacheEntry[]>;
  readSegment(key: string, index: number): Promise<Uint8Array | undefined>;
  /** Writes the entry and all its segments atomically. */
  write(entry: NarrationCacheEntry, segments: readonly Uint8Array[]): Promise<void>;
  touch(key: string, lastUsedAt: number): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface CachedNarration {
  segments: number;
  read(index: number): Promise<Uint8Array>;
}

export class NarrationCacheMissingError extends Error {
  constructor() {
    super('Saved narration was cleared while it played');
    this.name = 'NarrationCacheMissingError';
  }
}

export class NarrationCache {
  constructor(
    private readonly store: NarrationCacheStore,
    private readonly limits = {
      maxBytes: NARRATION_CACHE_MAX_BYTES,
      ttlMs: NARRATION_CACHE_TTL_MS,
    },
    private readonly now: () => number = Date.now,
  ) {}

  private expired(entry: NarrationCacheEntry, now: number): boolean {
    return now - entry.createdAt >= this.limits.ttlMs;
  }

  /** A complete, unexpired narration, marked as just used. */
  async lookup(key: string): Promise<CachedNarration | null> {
    const entry = await this.store.getEntry(key);
    if (!entry) return null;
    const now = this.now();
    if (this.expired(entry, now)) {
      await this.store.remove([key]);
      return null;
    }
    await this.store.touch(key, now);
    return {
      segments: entry.segments,
      read: async (index) => {
        const pcm = await this.store.readSegment(key, index);
        if (!pcm) throw new NarrationCacheMissingError();
        return pcm;
      },
    };
  }

  async has(key: string): Promise<boolean> {
    const entry = await this.store.getEntry(key);
    return Boolean(entry && !this.expired(entry, this.now()));
  }

  /** Saves a fully downloaded narration, then evicts down to the limits. */
  async put(key: string, segments: readonly Uint8Array[]): Promise<void> {
    const bytes = segments.reduce((sum, pcm) => sum + pcm.byteLength, 0);
    if (bytes === 0 || bytes > this.limits.maxBytes) return;
    const now = this.now();
    await this.store.write(
      { key, bytes, segments: segments.length, createdAt: now, lastUsedAt: now },
      segments,
    );
    await this.evict();
  }

  /** Drops expired entries, then the least recently used until under the byte limit. */
  async evict(): Promise<void> {
    const now = this.now();
    const entries = await this.store.listEntries();
    const doomed: string[] = [];
    const kept: NarrationCacheEntry[] = [];
    for (const entry of entries) {
      if (this.expired(entry, now)) doomed.push(entry.key);
      else kept.push(entry);
    }
    kept.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of kept) {
      if (total <= this.limits.maxBytes) break;
      doomed.push(entry.key);
      total -= entry.bytes;
    }
    if (doomed.length > 0) await this.store.remove(doomed);
  }

  async usage(): Promise<{ entries: number; bytes: number }> {
    const now = this.now();
    const live = (await this.store.listEntries()).filter(
      (entry) => !this.expired(entry, now),
    );
    return {
      entries: live.length,
      bytes: live.reduce((sum, entry) => sum + entry.bytes, 0),
    };
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }
}

export function narrationMinutes(bytes: number): number {
  return bytes / MINUTE_BYTES;
}

const DB_NAME = 'autovox-narration';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const SEGMENTS = 'segments';

type StoredSegment = { key: string; index: number; pcm: Uint8Array };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
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

function segmentRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);
}

/** Extension-origin IndexedDB: page scripts and content scripts can't open it. */
export class IndexedDbNarrationStore implements NarrationCacheStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ENTRIES)) {
          db.createObjectStore(ENTRIES, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(SEGMENTS)) {
          db.createObjectStore(SEGMENTS, { keyPath: ['key', 'index'] });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another context upgrading the schema must not wait on this connection.
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.db = null;
        reject(request.error ?? new Error('Could not open the narration cache'));
      };
    });
    return this.db;
  }

  async getEntry(key: string): Promise<NarrationCacheEntry | undefined> {
    const db = await this.open();
    const store = db.transaction(ENTRIES, 'readonly').objectStore(ENTRIES);
    return (await requestResult(store.get(key))) as NarrationCacheEntry | undefined;
  }

  async listEntries(): Promise<NarrationCacheEntry[]> {
    const db = await this.open();
    const store = db.transaction(ENTRIES, 'readonly').objectStore(ENTRIES);
    return (await requestResult(store.getAll())) as NarrationCacheEntry[];
  }

  async readSegment(key: string, index: number): Promise<Uint8Array | undefined> {
    const db = await this.open();
    const store = db.transaction(SEGMENTS, 'readonly').objectStore(SEGMENTS);
    const row = (await requestResult(store.get([key, index]))) as
      | StoredSegment
      | undefined;
    return row?.pcm;
  }

  async write(
    entry: NarrationCacheEntry,
    segments: readonly Uint8Array[],
  ): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([ENTRIES, SEGMENTS], 'readwrite');
    const done = transactionDone(transaction);
    const segmentStore = transaction.objectStore(SEGMENTS);
    segmentStore.delete(segmentRange(entry.key));
    segments.forEach((pcm, index) => {
      segmentStore.put({ key: entry.key, index, pcm } satisfies StoredSegment);
    });
    transaction.objectStore(ENTRIES).put(entry);
    await done;
  }

  async touch(key: string, lastUsedAt: number): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(ENTRIES, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(ENTRIES);
    const request = store.get(key);
    request.onsuccess = () => {
      const entry = request.result as NarrationCacheEntry | undefined;
      if (entry) store.put({ ...entry, lastUsedAt });
    };
    await done;
  }

  async remove(keys: readonly string[]): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([ENTRIES, SEGMENTS], 'readwrite');
    const done = transactionDone(transaction);
    for (const key of keys) {
      transaction.objectStore(ENTRIES).delete(key);
      transaction.objectStore(SEGMENTS).delete(segmentRange(key));
    }
    await done;
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([ENTRIES, SEGMENTS], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(ENTRIES).clear();
    transaction.objectStore(SEGMENTS).clear();
    await done;
  }
}

let shared: NarrationCache | null = null;

/** The profile's narration cache, shared by the background and Options. */
export function narrationCache(): NarrationCache {
  shared ??= new NarrationCache(new IndexedDbNarrationStore());
  return shared;
}
