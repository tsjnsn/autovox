import assert from "node:assert/strict";
import test from "node:test";
import { frameAt } from "../utils/chalk/timeline";
import { flattenBeats, type ChalkLesson } from "../utils/chalk/types";
import { scenePlayback } from "../utils/artifactPlayback";
import {
  ArtifactHistory,
  artifactFromBrief,
  artifactPageUrl,
  mergeDrawings,
  type Artifact,
  type HistoryStore,
} from "../utils/history";
import type { BriefResult } from "../utils/types";

class MemoryHistoryStore implements HistoryStore {
  readonly rows = new Map<string, Artifact>();

  get(id: string): Promise<Artifact | undefined> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  list(): Promise<Artifact[]> {
    return Promise.resolve([...this.rows.values()].map((row) => structuredClone(row)));
  }

  put(artifact: Artifact): Promise<void> {
    this.rows.set(artifact.id, structuredClone(artifact));
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.rows.clear();
    return Promise.resolve();
  }
}

function brief(id: string, headline: string): BriefResult {
  return {
    source: {
      title: "Tide tables",
      url: "https://news.example/tides",
      siteName: "Example",
    },
    script: {
      headline,
      lede: "The moon pulls the water.",
      segments: ["Sailors kept tables."],
      estimatedSeconds: 40,
    },
    format: "brief",
    moneySessionId: id,
    managedSessionId: "server-session",
    articleType: { type: "news", source: "inferred" },
  };
}

function artifact(id: string, createdAt: number): Artifact {
  const filed = artifactFromBrief(brief(id, id), "https://news.example/tides", createdAt);
  if (!filed) throw new Error("expected an artifact");
  return filed;
}

void test("a filed brief keeps the page and the script, not the server session", () => {
  const filed = artifactFromBrief(
    brief("local-1", "Moon pull"),
    "https://news.example/tides",
    50,
  );
  assert.ok(filed);
  assert.equal(filed.id, "local-1");
  assert.equal(filed.headline, "Moon pull");
  assert.equal(filed.pageUrl, "https://news.example/tides");
  assert.equal(filed.articleType, "news");
  assert.equal(filed.script.lede, "The moon pulls the water.");
  assert.equal("managedSessionId" in filed, false);
  assert.equal(artifactFromBrief({ ...brief("x", "x"), moneySessionId: undefined }, "https://a", 1), null);
});

void test("library links only ordinary web pages", () => {
  assert.equal(artifactPageUrl("https://news.example/tides"), "https://news.example/tides");
  assert.equal(artifactPageUrl("http://news.example/tides"), "http://news.example/tides");
  assert.equal(artifactPageUrl("javascript:alert(1)"), null);
  assert.equal(artifactPageUrl("not a url"), null);
});

void test("a later save keeps art that already arrived", () => {
  const drawn = { elements: [{ kind: "text" as const, beat: 0, color: "white" as const, x: 0, y: 0, size: 12, text: "Moon" }] };
  const merged = mergeDrawings([drawn, null], [null, null]);
  assert.equal(merged?.[0]?.elements.length, 1);
  assert.equal(merged?.[1], null);
  assert.equal(mergeDrawings(null, null), null);
});

void test("the library lists newest first, updates in place, and drops the oldest", async () => {
  const store = new MemoryHistoryStore();
  let now = 1_000;
  const history = new ArtifactHistory(store, () => now, 2);

  await history.remember(artifact("a", 1));
  now = 2_000;
  await history.remember(artifact("b", 2));
  now = 3_000;
  await history.remember(artifact("c", 3));

  const listed = await history.list();
  assert.deepEqual(listed.map((item) => item.id), ["c", "b"]);

  now = 4_000;
  const updated = artifact("b", 9_999);
  updated.drawings = [null];
  updated.headline = "Updated";
  await history.remember(updated);
  const again = await history.list();
  const kept = again.find((item) => item.id === "b");
  assert.equal(kept?.createdAt, 2);
  assert.equal(kept?.headline, "Updated");
  assert.equal(kept?.drawings?.[0], null);

  await history.saveDrawings("b", [
    {
      elements: [
        { kind: "text", beat: 0, color: "white", x: 1, y: 2, size: 10, text: "Hi" },
      ],
    },
  ]);
  now = 5_000;
  await history.remember({ ...artifact("b", 9), drawings: [null] });
  const after = (await history.list()).find((item) => item.id === "b");
  assert.equal(after?.createdAt, 2);
  assert.equal(after?.drawings?.[0]?.elements.length, 1);

  await history.remove("c");
  assert.deepEqual((await history.list()).map((item) => item.id), ["b"]);
  await history.clear();
  assert.deepEqual(await history.list(), []);
});

const lesson: ChalkLesson = {
  title: "Tides",
  cast: [],
  estimatedSeconds: 30,
  scenes: [
    {
      heading: "Pull",
      visual: "moon",
      beats: [
        { say: "The moon pulls.", note: "Moon" },
        { say: "Water follows.", note: "Water" },
      ],
    },
    {
      heading: "Tables",
      visual: "chart",
      beats: [{ say: "Sailors kept tables.", note: "Tables" }],
    },
  ],
};

void test("a saved chalkboard scene is shown before the next scene starts", () => {
  const playback = scenePlayback(lesson);
  const beats = flattenBeats(lesson);
  assert.equal(frameAt(playback.sceneTime[0]!, beats, playback.timeline).scene, 0);
  assert.equal(frameAt(playback.sceneTime[1]!, beats, playback.timeline).scene, 1);
  const secondStart = playback.timeline.starts[2];
  assert.ok(playback.sceneTime[0]! < (secondStart ?? 0));
});
