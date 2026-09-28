import assert from "node:assert/strict";
import test from "node:test";
import { prefetchInOrder, type PrefetchEvent } from "../utils/prefetch";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect<T>(
  events: AsyncIterable<PrefetchEvent<T>>,
): Promise<string[]> {
  const out: string[] = [];
  for await (const event of events) {
    out.push("done" in event ? `${event.index}:done` : `${event.index}:${String(event.chunk)}`);
  }
  return out;
}

void test("yields streams strictly in order even when later ones finish first", async () => {
  const delays = [30, 5, 1];
  const events = prefetchInOrder(
    3,
    async function* (index) {
      await sleep(delays[index]!);
      yield `a${index}`;
      yield `b${index}`;
    },
    2,
  );
  assert.deepEqual(await collect(events), [
    "0:a0",
    "0:b0",
    "0:done",
    "1:a1",
    "1:b1",
    "1:done",
    "2:a2",
    "2:b2",
    "2:done",
  ]);
});

void test("keeps at most lookahead streams downloading ahead of the consumer", async () => {
  let open = 0;
  let peak = 0;
  const opened: number[] = [];
  const events = prefetchInOrder(
    5,
    async function* (index) {
      opened.push(index);
      open += 1;
      peak = Math.max(peak, open);
      try {
        await sleep(5);
        yield index;
      } finally {
        open -= 1;
      }
    },
    1,
  );
  await collect(events);
  assert.deepEqual(opened, [0, 1, 2, 3, 4]);
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
});

void test("lookahead 0 downloads one stream at a time", async () => {
  const log: string[] = [];
  const events = prefetchInOrder(
    3,
    async function* (index) {
      log.push(`open ${index}`);
      await sleep(1);
      yield index;
      log.push(`close ${index}`);
    },
    0,
  );
  await collect(events);
  assert.deepEqual(log, ["open 0", "close 0", "open 1", "close 1", "open 2", "close 2"]);
});

void test("a prefetched failure surfaces only when the consumer reaches it", async () => {
  const seen: string[] = [];
  const events = prefetchInOrder(
    3,
    async function* (index) {
      if (index === 1) throw new Error("beat 1 failed");
      await sleep(10);
      yield `ok${index}`;
    },
    2,
  );
  await assert.rejects(async () => {
    for await (const event of events) {
      seen.push("done" in event ? `${event.index}:done` : `${event.index}:${event.chunk}`);
    }
  }, /beat 1 failed/);
  assert.deepEqual(seen, ["0:ok0", "0:done"]);
});
