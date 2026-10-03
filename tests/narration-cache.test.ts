import assert from "node:assert/strict";
import test from "node:test";
import {
  NarrationCache,
  NarrationCacheMissingError,
  narrationCacheKey,
  type NarrationKeyInput,
} from "../utils/narrationCache";
import { MemoryNarrationStore } from "./memoryNarrationStore";

const base: NarrationKeyInput = {
  texts: ["The council voted.", "Then it adjourned."],
  voice: "sage",
  model: "gpt-audio-mini",
  instructions: "Read like a news anchor.",
  articleType: "news",
  outputLanguage: "en",
  authMode: "openrouter",
};

void test("narration key is a stable SHA-256 of every input", async () => {
  const key = await narrationCacheKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(await narrationCacheKey({ ...base, texts: [...base.texts] }), key);
});

void test("changing any narration input changes the key", async () => {
  const variants: [string, NarrationKeyInput][] = [
    ["script text", { ...base, texts: ["The council voted!", "Then it adjourned."] }],
    ["segment split", { ...base, texts: ["The council voted. Then it adjourned."] }],
    ["segment boundary", { ...base, texts: ["The council voted.Then", " it adjourned."] }],
    ["segment order", { ...base, texts: [...base.texts].reverse() }],
    ["voice", { ...base, voice: "alloy" }],
    ["model", { ...base, model: "gpt-audio" }],
    ["instructions", { ...base, instructions: "Read like a teacher." }],
    ["article type", { ...base, articleType: "story" }],
    ["no article type", { ...base, articleType: null }],
    ["language", { ...base, outputLanguage: "fr" }],
    ["auth mode: OpenAI key", { ...base, authMode: "apiKey" }],
    ["auth mode: managed", { ...base, authMode: "managed" }],
  ];
  const baseKey = await narrationCacheKey(base);
  const seen = new Set([baseKey]);
  for (const [label, input] of variants) {
    const key = await narrationCacheKey(input);
    assert.notEqual(key, baseKey, label);
    seen.add(key);
  }
  assert.equal(seen.size, variants.length + 1, "every variant has its own key");
});

function pcm(bytes: number, fill = 1): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

function cacheWithClock(maxBytes: number, ttlMs: number) {
  const store = new MemoryNarrationStore();
  const clock = { now: 1_000 };
  const cache = new NarrationCache(store, { maxBytes, ttlMs }, () => clock.now);
  return { store, clock, cache };
}

void test("a saved narration reads back segment by segment", async () => {
  const { cache } = cacheWithClock(1_000, 60_000);
  await cache.put("a", [pcm(4, 1), pcm(6, 2)]);
  const hit = await cache.lookup("a");
  assert.ok(hit);
  assert.equal(hit.segments, 2);
  assert.deepEqual(await hit.read(0), pcm(4, 1));
  assert.deepEqual(await hit.read(1), pcm(6, 2));
  assert.deepEqual(await cache.usage(), { entries: 1, bytes: 10 });
});

void test("over the byte limit, the least recently used narration goes first", async () => {
  const { cache, clock } = cacheWithClock(10, 60_000);
  await cache.put("a", [pcm(4)]);
  clock.now += 1;
  await cache.put("b", [pcm(4)]);
  clock.now += 1;
  assert.ok(await cache.lookup("a"), "replaying a makes it recently used");
  clock.now += 1;
  await cache.put("c", [pcm(4)]);

  assert.equal(await cache.has("a"), true);
  assert.equal(await cache.has("b"), false);
  assert.equal(await cache.has("c"), true);
  assert.deepEqual(await cache.usage(), { entries: 2, bytes: 8 });
});

void test("a narration larger than the whole cache is not saved", async () => {
  const { cache } = cacheWithClock(10, 60_000);
  await cache.put("a", [pcm(4)]);
  await cache.put("huge", [pcm(8), pcm(8)]);
  assert.equal(await cache.has("huge"), false);
  assert.equal(await cache.has("a"), true, "nothing is evicted for it");
});

void test("empty narration is not saved", async () => {
  const { cache } = cacheWithClock(10, 60_000);
  await cache.put("silent", [new Uint8Array(0)]);
  assert.equal(await cache.has("silent"), false);
});

void test("narration expires a TTL after it was saved, even if replayed", async () => {
  const { cache, clock, store } = cacheWithClock(1_000, 100);
  await cache.put("a", [pcm(4)]);
  clock.now += 60;
  assert.ok(await cache.lookup("a"));
  clock.now += 40;
  assert.equal(await cache.has("a"), false);
  assert.equal(await cache.lookup("a"), null);
  assert.equal(store.entries.has("a"), false, "lookup removes the expired entry");
});

void test("eviction sweeps expired narration without touching live entries", async () => {
  const { cache, clock, store } = cacheWithClock(1_000, 100);
  await cache.put("old", [pcm(4)]);
  clock.now += 50;
  await cache.put("new", [pcm(4)]);
  clock.now += 60;
  assert.deepEqual(await cache.usage(), { entries: 1, bytes: 4 });
  await cache.evict();
  assert.deepEqual([...store.entries.keys()], ["new"]);
});

void test("a segment cleared mid-replay reports a missing narration", async () => {
  const { cache } = cacheWithClock(1_000, 60_000);
  await cache.put("a", [pcm(4), pcm(4)]);
  const hit = await cache.lookup("a");
  assert.ok(hit);
  await cache.clear();
  await assert.rejects(hit.read(1), NarrationCacheMissingError);
  assert.deepEqual(await cache.usage(), { entries: 0, bytes: 0 });
});
