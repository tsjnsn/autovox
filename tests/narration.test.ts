import assert from "node:assert/strict";
import test from "node:test";
import { managedError } from "../convex/lib/errors";
import type { LlmAuth } from "../utils/auth";
import { briefErrorKind } from "../utils/errors";
import {
  ensureManagedNarrationSession,
  narrationPlan,
  runNarration,
  type ManagedSessionDeps,
  type NarrationDeps,
  type NarrationSegmentOptions,
} from "../utils/narration";
import { NarrationCache, narrationCacheKey } from "../utils/narrationCache";
import type {
  NarrationRequest,
  NarrationServerMessage,
} from "../utils/narrationProtocol";
import { base64ToBytes } from "../utils/pcmFormat";
import type { BriefResult, ManagedLifecycleEvent, Settings } from "../utils/types";
import { MemoryNarrationStore } from "./memoryNarrationStore";

const byok: Settings = {
  providerMode: "byok",
  apiKey: "",
  openRouterApiKey: "sk-or-user",
  voice: "sage",
  reportLength: "standard",
  outputLanguage: "en",
  articleType: "infer",
  comprehensionModel: "gpt-6-luna",
  drawingModel: "",
  ttsModel: "gpt-audio-mini",
};

const managed: Settings = { ...byok, providerMode: "managed", openRouterApiKey: "" };

const brief: BriefResult = {
  source: { title: "Council", url: "https://example.com/a", siteName: null },
  script: {
    headline: "Council votes",
    lede: "The council voted on Tuesday.",
    segments: ["It passed seven to two.", "The mayor will sign it."],
    estimatedSeconds: 30,
  },
  format: "brief",
  reportLength: "standard",
  outputLanguage: "en",
  moneySessionId: "money-brief",
  managedSessionId: "managed-brief",
};

const managedAuth: LlmAuth = {
  mode: "openrouter",
  apiKey: "sk-or-managed",
  baseUrl: "https://openrouter.ai/api",
  managed: true,
};

function request(overrides: Partial<NarrationRequest> = {}): NarrationRequest {
  return {
    briefId: "money-brief",
    moneySessionId: "money-brief",
    managedSessionId: null,
    ...overrides,
  };
}

function segmentAudio(index: number): Uint8Array[] {
  return [new Uint8Array([index, 1, index, 2]), new Uint8Array([index, 3])];
}

function never(name: string) {
  return () => {
    throw new Error(`${name} must not be called`);
  };
}

/** A provider whose segment i streams segmentAudio(i), then reports usage. */
function fakeProvider() {
  const calls: NarrationSegmentOptions[] = [];
  const openSegment = async function* (options: NarrationSegmentOptions) {
    calls.push(options);
    const index = calls.length - 1;
    for (const chunk of segmentAudio(index)) {
      await Promise.resolve();
      if (options.signal.aborted) return;
      yield chunk;
    }
    await options.onUsage({ costUsd: 0.01, costKnown: true, generationId: `gen-${index}` });
  };
  return { calls, openSegment };
}

function deps(overrides: Partial<NarrationDeps> & { settings?: Settings } = {}) {
  const store = new MemoryNarrationStore();
  const cache = new NarrationCache(store);
  const base: NarrationDeps = {
    loadBrief: () => Promise.resolve(brief),
    loadSettings: () => Promise.resolve(overrides.settings ?? byok),
    cache,
    managedAuth: never("managedAuth"),
    acquireManaged: never("acquireManaged"),
    openSegment: never("openSegment"),
    attachUsage: () => Promise.resolve("money-brief"),
  };
  return { store, cache, deps: { ...base, ...overrides } };
}

async function run(
  narrationDeps: NarrationDeps,
  narrationRequest = request(),
  signal = new AbortController().signal,
) {
  const messages: NarrationServerMessage[] = [];
  await runNarration(narrationRequest, signal, (message) => messages.push(message), narrationDeps);
  return messages;
}

function audioBySegment(messages: NarrationServerMessage[]): number[][] {
  const out: number[][] = [];
  for (const message of messages) {
    if (message.type !== "chunk") continue;
    (out[message.index] ??= []).push(...base64ToBytes(message.pcm));
  }
  return out;
}

void test("the narration plan matches what the overlay used to send", () => {
  const plan = narrationPlan(brief, byok);
  assert.equal(plan.voice, "sage");
  assert.equal(plan.model, "gpt-audio-mini");
  assert.equal(plan.authMode, "openrouter");
  assert.equal(plan.prefetch, 0);
  assert.equal(plan.articleType, null);
  assert.ok(plan.texts.length >= 1);
  assert.equal(narrationPlan(brief, managed).authMode, "managed");
});

void test("a miss streams from the provider, records spend, and saves the audio", async () => {
  const provider = fakeProvider();
  const usage: (string | null)[] = [];
  const { deps: narrationDeps, cache } = deps({
    openSegment: provider.openSegment,
    attachUsage: (_usage, moneySessionId) => {
      usage.push(moneySessionId);
      return Promise.resolve("money-replay");
    },
  });
  const messages = await run(narrationDeps);
  const plan = narrationPlan(brief, byok);

  assert.deepEqual(messages[0], { type: "plan", segments: plan.texts.length, cached: false });
  assert.equal(messages.at(-1)?.type, "end");
  assert.equal(provider.calls.length, plan.texts.length);
  assert.equal(provider.calls[0]!.auth.apiKey, "sk-or-user");
  assert.equal(provider.calls[0]!.voice, "sage");
  assert.deepEqual(
    messages.filter((m) => m.type === "money"),
    [{ type: "money", sessionId: "money-replay" }],
    "the overlay learns the replay spend session once",
  );
  assert.deepEqual(usage[0], "money-brief");
  assert.deepEqual(
    audioBySegment(messages),
    plan.texts.map((_, i) => segmentAudio(i).flatMap((chunk) => [...chunk])),
  );
  const saved = await cache.lookup(await narrationCacheKey(plan));
  assert.ok(saved, "the full narration was saved");
  assert.deepEqual([...(await saved.read(0))], segmentAudio(0).flatMap((c) => [...c]));
});

void test("a managed cache hit replays without a session, a key, or spend", async () => {
  const { deps: narrationDeps, cache } = deps({ settings: managed });
  const plan = narrationPlan(brief, managed);
  const segments = plan.texts.map((_, i) => new Uint8Array(200_000).fill(i + 1));
  await cache.put(await narrationCacheKey(plan), segments);
  narrationDeps.attachUsage = never("attachUsage");

  const messages = await run(narrationDeps, request({ managedSessionId: null }));

  assert.deepEqual(messages[0], { type: "plan", segments: plan.texts.length, cached: true });
  assert.equal(messages.at(-1)?.type, "end");
  assert.ok(!messages.some((m) => m.type === "managed" || m.type === "money"));
  assert.deepEqual(
    audioBySegment(messages).map((bytes) => bytes.length),
    segments.map((s) => s.byteLength),
  );
  assert.ok(
    messages.filter((m) => m.type === "chunk").length > plan.texts.length,
    "long segments replay in slices",
  );
  assert.deepEqual(
    messages.filter((m) => m.type === "segment_done").map((m) => m.type === "segment_done" && m.index),
    plan.texts.map((_, i) => i),
  );
});

void test("managed narration spends through the prepared session's key", async () => {
  const provider = fakeProvider();
  const { deps: narrationDeps } = deps({
    settings: managed,
    managedAuth: (sessionId) =>
      Promise.resolve(sessionId === "managed-replay" ? managedAuth : null),
    openSegment: provider.openSegment,
  });
  await run(narrationDeps, request({ managedSessionId: "managed-replay" }));
  assert.equal(provider.calls[0]!.auth.apiKey, "sk-or-managed");
});

void test("an ended managed session fails as setup, without calling the provider", async () => {
  const { deps: narrationDeps } = deps({
    settings: managed,
    managedAuth: () => Promise.resolve(null),
  });
  await assert.rejects(run(narrationDeps, request({ managedSessionId: "managed-brief" })), (error) => {
    assert.equal(briefErrorKind(error), "setup");
    return true;
  });
});

void test("a managed miss with no session acquires one and tells the overlay", async () => {
  const provider = fakeProvider();
  let acquired = 0;
  const { deps: narrationDeps } = deps({
    settings: managed,
    acquireManaged: () => {
      acquired += 1;
      return Promise.resolve({ sessionId: "managed-replay", auth: managedAuth });
    },
    openSegment: provider.openSegment,
  });
  const messages = await run(narrationDeps, request({ managedSessionId: null }));
  assert.equal(acquired, 1);
  const managedAt = messages.findIndex((m) => m.type === "managed");
  const firstChunk = messages.findIndex((m) => m.type === "chunk");
  assert.deepEqual(messages[managedAt], { type: "managed", sessionId: "managed-replay" });
  assert.ok(managedAt < firstChunk);
});

void test("a brief that is no longer saved for the tab is refused", async () => {
  const { deps: narrationDeps } = deps();
  await assert.rejects(run(narrationDeps, request({ briefId: "money-other" })), (error) => {
    assert.equal(briefErrorKind(error), "fault");
    return true;
  });
  const gone = deps({ loadBrief: () => Promise.resolve(null) });
  await assert.rejects(run(gone.deps), /no longer saved/);
});

void test("aborting mid-stream stops without end and saves nothing", async () => {
  const abort = new AbortController();
  const provider = fakeProvider();
  const { deps: narrationDeps, store } = deps({ openSegment: provider.openSegment });
  const messages: NarrationServerMessage[] = [];
  await runNarration(
    request(),
    abort.signal,
    (message) => {
      messages.push(message);
      if (message.type === "chunk") abort.abort();
    },
    narrationDeps,
  );
  assert.equal(messages.filter((m) => m.type === "chunk").length, 1);
  assert.ok(!messages.some((m) => m.type === "end"));
  assert.equal(provider.calls[0]!.signal.aborted, true, "the provider request is aborted");
  assert.equal(store.entries.size, 0);
});

function managedDeps(options: { live?: string[]; failOpens?: number } = {}) {
  const reports: [string, ManagedLifecycleEvent["type"]][] = [];
  let opens = 0;
  const sessionDeps: ManagedSessionDeps = {
    sessionAuth: (sessionId) =>
      Promise.resolve(options.live?.includes(sessionId) ? managedAuth : null),
    report: (sessionId, event) => {
      reports.push([sessionId, event.type]);
      return Promise.resolve();
    },
    openReplay: () => {
      opens += 1;
      if (opens <= (options.failOpens ?? 0)) {
        return Promise.reject(managedError("session_in_progress", "Another session is open"));
      }
      return Promise.resolve({ sessionId: `replay-${opens}`, auth: managedAuth });
    },
    sleep: () => Promise.resolve(),
  };
  return { sessionDeps, reports, opens: () => opens };
}

const managedRequest = {
  sessionId: "managed-brief",
  estimatedSeconds: 30,
  reportLength: "standard" as const,
  voice: "sage" as const,
  outputLanguage: "en" as const,
};

void test("a live managed session is reused whether or not narration is cached", async () => {
  for (const cached of [false, true]) {
    const { sessionDeps, reports, opens } = managedDeps({ live: ["managed-brief"] });
    const session = await ensureManagedNarrationSession(managedRequest, cached, sessionDeps);
    assert.deepEqual(session, { sessionId: "managed-brief", auth: managedAuth });
    assert.deepEqual(reports, []);
    assert.equal(opens(), 0);
  }
});

void test("a cached narration on an ended session opens no tts_replay session", async () => {
  const { sessionDeps, reports, opens } = managedDeps();
  const session = await ensureManagedNarrationSession(managedRequest, true, sessionDeps);
  assert.deepEqual(session, { sessionId: null, auth: null });
  assert.equal(opens(), 0, "no replay session, so no credit");
  assert.deepEqual(reports, [["managed-brief", "aborted"]]);
});

void test("an uncached narration on an ended session opens a replay as before", async () => {
  const { sessionDeps, reports, opens } = managedDeps({ failOpens: 1 });
  const session = await ensureManagedNarrationSession(managedRequest, false, sessionDeps);
  assert.deepEqual(session, { sessionId: "replay-2", auth: managedAuth });
  assert.equal(opens(), 2, "retries while the previous session closes");
  assert.deepEqual(reports, [
    ["managed-brief", "aborted"],
    ["replay-2", "script_ready"],
  ]);
});
