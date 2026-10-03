import type {
  NarrationCacheEntry,
  NarrationCacheStore,
} from "../utils/narrationCache";

/** The narration cache's storage in memory, for policy tests. */
export class MemoryNarrationStore implements NarrationCacheStore {
  readonly entries = new Map<string, NarrationCacheEntry>();
  readonly segments = new Map<string, Uint8Array[]>();

  getEntry(key: string): Promise<NarrationCacheEntry | undefined> {
    const entry = this.entries.get(key);
    return Promise.resolve(entry ? { ...entry } : undefined);
  }

  listEntries(): Promise<NarrationCacheEntry[]> {
    return Promise.resolve([...this.entries.values()].map((entry) => ({ ...entry })));
  }

  readSegment(key: string, index: number): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.segments.get(key)?.[index]);
  }

  write(entry: NarrationCacheEntry, segments: readonly Uint8Array[]): Promise<void> {
    this.entries.set(entry.key, { ...entry });
    this.segments.set(entry.key, segments.map((pcm) => pcm.slice()));
    return Promise.resolve();
  }

  touch(key: string, lastUsedAt: number): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsedAt = lastUsedAt;
    return Promise.resolve();
  }

  remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.entries.delete(key);
      this.segments.delete(key);
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries.clear();
    this.segments.clear();
    return Promise.resolve();
  }
}
