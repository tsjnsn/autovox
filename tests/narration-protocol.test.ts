import assert from "node:assert/strict";
import test from "node:test";
import { briefErrorKind, RelayedError } from "../utils/errors";
import {
  serveNarrationPort,
  streamNarration,
  type NarrationEmit,
  type NarrationPort,
  type NarrationRequest,
} from "../utils/narrationProtocol";
import { bytesToBase64 } from "../utils/pcmFormat";
import type { PrefetchEvent } from "../utils/prefetch";
import { OpenAIError } from "../utils/providerError";

/** One end of a runtime port: JSON messages, async delivery, onDisconnect only on the far end. */
class FakePort implements NarrationPort {
  peer!: FakePort;
  connected = true;
  readonly received: unknown[] = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  readonly onMessage = {
    addListener: (callback: (message: unknown) => void) => this.messageListeners.add(callback),
    removeListener: (callback: (message: unknown) => void) =>
      this.messageListeners.delete(callback),
  };

  readonly onDisconnect = {
    addListener: (callback: () => void) => this.disconnectListeners.add(callback),
    removeListener: (callback: () => void) => this.disconnectListeners.delete(callback),
  };

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error("Attempting to use a disconnected port object");
    const copy: unknown = JSON.parse(JSON.stringify(message));
    const peer = this.peer;
    setTimeout(() => {
      if (!peer.connected) return;
      peer.received.push(copy);
      for (const listener of [...peer.messageListeners]) listener(copy);
    }, 0);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.peer.connected = false;
    const peer = this.peer;
    setTimeout(() => {
      for (const listener of [...peer.disconnectListeners]) listener();
    }, 0);
  }
}

function portPair(): { overlay: FakePort; background: FakePort } {
  const overlay = new FakePort();
  const background = new FakePort();
  overlay.peer = background;
  background.peer = overlay;
  return { overlay, background };
}

const narrationRequest: NarrationRequest = {
  briefId: "money-brief",
  moneySessionId: "money-brief",
  managedSessionId: "managed-brief",
};

type Run = (
  request: NarrationRequest,
  signal: AbortSignal,
  emit: NarrationEmit,
) => Promise<void>;

function serve(run: Run) {
  const { overlay, background } = portPair();
  serveNarrationPort(background, run);
  return { overlay, background };
}

async function collect(
  events: AsyncIterable<PrefetchEvent<Uint8Array>>,
): Promise<{ index: number; bytes?: number[]; done?: true }[]> {
  const out: { index: number; bytes?: number[]; done?: true }[] = [];
  for await (const event of events) {
    out.push("done" in event ? { index: event.index, done: true } : { index: event.index, bytes: [...event.chunk] });
  }
  return out;
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `port` has received `count` messages that match. */
function received(
  port: FakePort,
  matches: (message: unknown) => boolean,
  count = 1,
): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (port.received.filter(matches).length < count) return;
      port.onMessage.removeListener(check);
      resolve();
    };
    port.onMessage.addListener(check);
    check();
  });
}

const isKeepalive = (message: unknown) => (message as { type?: string }).type === "keepalive";

void test("chunks arrive in order as PCM, with spend and session updates", async () => {
  let seen: NarrationRequest | null = null;
  const { overlay } = serve(async (request, _signal, emit) => {
    seen = request;
    emit({ type: "plan", segments: 2, cached: false });
    emit({ type: "managed", sessionId: "managed-replay" });
    emit({ type: "chunk", index: 0, pcm: bytesToBase64(new Uint8Array([1, 2])) });
    emit({ type: "segment_done", index: 0 });
    emit({ type: "money", sessionId: "money-replay" });
    emit({ type: "chunk", index: 1, pcm: bytesToBase64(new Uint8Array([3, 4])) });
    emit({ type: "segment_done", index: 1 });
    emit({ type: "end" });
    await Promise.resolve();
  });
  const money: string[] = [];
  const managed: string[] = [];
  const events = await collect(
    streamNarration({
      connect: () => overlay,
      request: narrationRequest,
      expectedSegments: 2,
      signal: new AbortController().signal,
      onMoneySession: (id) => money.push(id),
      onManagedSession: (id) => managed.push(id),
    }),
  );
  assert.deepEqual(seen, narrationRequest);
  assert.deepEqual(events, [
    { index: 0, bytes: [1, 2] },
    { index: 0, done: true },
    { index: 1, bytes: [3, 4] },
    { index: 1, done: true },
  ]);
  assert.deepEqual(money, ["money-replay"]);
  assert.deepEqual(managed, ["managed-replay"]);
  assert.equal(overlay.connected, false, "the overlay closes the port after end");
});

void test("a background failure keeps its message and kind", async () => {
  const { overlay } = serve(() => Promise.reject(new OpenAIError("Insufficient credits", 402)));
  await assert.rejects(
    collect(
      streamNarration({
        connect: () => overlay,
        request: narrationRequest,
        expectedSegments: 1,
        signal: new AbortController().signal,
      }),
    ),
    (error) => {
      assert.ok(error instanceof RelayedError);
      assert.equal(error.message, "Insufficient credits");
      assert.equal(briefErrorKind(error), "credits");
      return true;
    },
  );
});

void test("aborting the overlay stops the background run", async () => {
  let backgroundAborted = false;
  const { overlay, background } = serve(async (_request, signal, emit) => {
    emit({ type: "plan", segments: 1, cached: false });
    emit({ type: "chunk", index: 0, pcm: bytesToBase64(new Uint8Array([9])) });
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
    backgroundAborted = true;
    emit({ type: "chunk", index: 0, pcm: bytesToBase64(new Uint8Array([10])) });
  });
  const abort = new AbortController();
  const events: PrefetchEvent<Uint8Array>[] = [];
  for await (const event of streamNarration({
    connect: () => overlay,
    request: narrationRequest,
    expectedSegments: 1,
    signal: abort.signal,
  })) {
    events.push(event);
    abort.abort();
  }
  await tick();
  assert.equal(events.length, 1, "nothing is yielded after abort");
  assert.equal(backgroundAborted, true);
  assert.equal(background.connected, false);
});

void test("returning early from the stream closes the port", async () => {
  let backgroundAborted = false;
  const { overlay } = serve(async (_request, signal, emit) => {
    emit({ type: "plan", segments: 1, cached: false });
    emit({ type: "chunk", index: 0, pcm: bytesToBase64(new Uint8Array([1])) });
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
    backgroundAborted = true;
  });
  for await (const event of streamNarration({
    connect: () => overlay,
    request: narrationRequest,
    expectedSegments: 1,
    signal: new AbortController().signal,
  })) {
    assert.equal(event.index, 0);
    break;
  }
  await tick();
  assert.equal(backgroundAborted, true);
});

void test("an aborted signal never opens a port", async () => {
  const abort = new AbortController();
  abort.abort();
  let connected = false;
  const events = await collect(
    streamNarration({
      connect: () => {
        connected = true;
        return portPair().overlay;
      },
      request: narrationRequest,
      expectedSegments: 1,
      signal: abort.signal,
    }),
  );
  assert.deepEqual(events, []);
  assert.equal(connected, false);
});

void test("a background that disconnects before end fails as transient", async () => {
  const { overlay } = serve(async (_request, _signal, emit) => {
    emit({ type: "plan", segments: 1, cached: false });
    emit({ type: "chunk", index: 0, pcm: bytesToBase64(new Uint8Array([1])) });
    await Promise.resolve();
  });
  const events: PrefetchEvent<Uint8Array>[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of streamNarration({
        connect: () => overlay,
        request: narrationRequest,
        expectedSegments: 1,
        signal: new AbortController().signal,
      })) {
        events.push(event);
        overlay.peer.disconnect();
      }
    })(),
    (error) => {
      assert.ok(error instanceof RelayedError);
      assert.equal(briefErrorKind(error), "transient");
      return true;
    },
  );
  assert.equal(events.length, 1);
});

void test("a plan for a different brief fails before any audio", async () => {
  const { overlay } = serve(async (_request, _signal, emit) => {
    emit({ type: "plan", segments: 3, cached: true });
    emit({ type: "chunk", index: 0, pcm: bytesToBase64(new Uint8Array([1])) });
    await Promise.resolve();
  });
  await assert.rejects(
    collect(
      streamNarration({
        connect: () => overlay,
        request: narrationRequest,
        expectedSegments: 2,
        signal: new AbortController().signal,
      }),
    ),
    (error) => briefErrorKind(error) === "fault",
  );
});

void test("keepalives reach the background without restarting the run", async () => {
  let runs = 0;
  const { overlay, background } = serve(async (_request, _signal, emit) => {
    runs += 1;
    emit({ type: "plan", segments: 1, cached: false });
    await received(background, isKeepalive, 2);
    emit({ type: "end" });
  });
  await collect(
    streamNarration({
      connect: () => overlay,
      request: narrationRequest,
      expectedSegments: 1,
      signal: new AbortController().signal,
      keepaliveMs: 5,
    }),
  );
  assert.equal(runs, 1);
});

void test("a malformed start is refused", async () => {
  const { overlay, background } = portPair();
  let runs = 0;
  serveNarrationPort(background, () => {
    runs += 1;
    return Promise.resolve();
  });
  overlay.postMessage({ type: "start", request: { briefId: 42 } });
  await received(overlay, () => true);
  await tick();
  assert.equal(runs, 0);
  assert.deepEqual(overlay.received, [
    { type: "error", message: "Invalid narration request", kind: "fault" },
  ]);
});
