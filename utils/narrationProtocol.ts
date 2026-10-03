import {
  briefErrorKind,
  errorMessage,
  RelayedError,
  type BriefErrorKind,
} from './errors';
import { base64ToBytes } from './pcmFormat';
import type { PrefetchEvent } from './prefetch';

/**
 * The overlay streams narration from the background over one runtime port per
 * run, so provider keys and provider requests stay out of the page's renderer.
 * Messages are JSON, so PCM travels as base64, the form providers send it in.
 */
export const NARRATION_PORT = 'autovox-narration';

/**
 * An idle service worker stops after 30 seconds, and a port doesn't keep it
 * alive by itself; a message from the page does.
 */
export const NARRATION_KEEPALIVE_MS = 15_000;

export interface NarrationRequest {
  /** The brief on screen (its spend session id); only the tab's saved brief is narrated. */
  briefId: string | null;
  /** Spend session TTS lines join; the background opens a replay session when it's closed. */
  moneySessionId: string | null;
  /** Managed session to spend through; null when no live session was needed. */
  managedSessionId: string | null;
}

export type NarrationClientMessage =
  | { type: 'start'; request: NarrationRequest }
  | { type: 'keepalive' };

export type NarrationServerMessage =
  | { type: 'plan'; segments: number; cached: boolean }
  | { type: 'chunk'; index: number; pcm: string }
  | { type: 'segment_done'; index: number }
  /** TTS lines now go to this spend session. */
  | { type: 'money'; sessionId: string }
  /** Narration opened this managed session; lifecycle reports go to it. */
  | { type: 'managed'; sessionId: string }
  | { type: 'end' }
  | { type: 'error'; message: string; kind: BriefErrorKind };

type Listener<A extends unknown[]> = {
  addListener(callback: (...args: A) => void): void;
  removeListener(callback: (...args: A) => void): void;
};

/** The part of `runtime.Port` the protocol uses. */
export interface NarrationPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: Listener<[message: unknown]>;
  onDisconnect: Listener<[]>;
}

const STOPPED_MESSAGE = 'Narration stopped unexpectedly';

function optionalString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 200);
}

export function parseNarrationRequest(value: unknown): NarrationRequest | null {
  if (value === null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (
    !optionalString(rec.briefId) ||
    !optionalString(rec.moneySessionId) ||
    !optionalString(rec.managedSessionId)
  ) {
    return null;
  }
  return {
    briefId: rec.briefId,
    moneySessionId: rec.moneySessionId,
    managedSessionId: rec.managedSessionId,
  };
}

/**
 * Overlay side: narration as the same in-order chunk/done events a local
 * download produced. Aborting `signal`, or returning early, closes the port,
 * which stops the provider requests. A port that closes before `end` is a
 * transient failure (the service worker stopped).
 */
export async function* streamNarration(options: {
  connect: () => NarrationPort;
  request: NarrationRequest;
  /** Segments the overlay expects; a different plan means the brief changed. */
  expectedSegments: number;
  signal: AbortSignal;
  onMoneySession?: (sessionId: string) => void;
  onManagedSession?: (sessionId: string) => void;
  keepaliveMs?: number;
}): AsyncGenerator<PrefetchEvent<Uint8Array>, void, unknown> {
  const { signal } = options;
  if (signal.aborted) return;

  const port = options.connect();
  const queue: NarrationServerMessage[] = [];
  let disconnected = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const onMessage = (message: unknown) => {
    queue.push(message as NarrationServerMessage);
    notify();
  };
  const onDisconnect = () => {
    disconnected = true;
    notify();
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  signal.addEventListener('abort', notify);
  const keepalive = setInterval(() => {
    try {
      port.postMessage({ type: 'keepalive' } satisfies NarrationClientMessage);
    } catch {
      // The disconnect listener reports it.
    }
  }, options.keepaliveMs ?? NARRATION_KEEPALIVE_MS);

  try {
    port.postMessage({
      type: 'start',
      request: options.request,
    } satisfies NarrationClientMessage);
    while (true) {
      if (signal.aborted) return;
      const message = queue.shift();
      if (!message) {
        if (disconnected) throw new RelayedError(STOPPED_MESSAGE, 'transient');
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      switch (message.type) {
        case 'plan':
          if (message.segments !== options.expectedSegments) {
            throw new RelayedError(
              'The brief changed before its narration started',
              'fault',
            );
          }
          break;
        case 'chunk':
          yield { index: message.index, chunk: base64ToBytes(message.pcm) };
          break;
        case 'segment_done':
          yield { index: message.index, done: true };
          break;
        case 'money':
          options.onMoneySession?.(message.sessionId);
          break;
        case 'managed':
          options.onManagedSession?.(message.sessionId);
          break;
        case 'error':
          throw new RelayedError(message.message, message.kind);
        case 'end':
          return;
      }
    }
  } finally {
    clearInterval(keepalive);
    signal.removeEventListener('abort', notify);
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    if (!disconnected) port.disconnect();
  }
}

export type NarrationEmit = (message: NarrationServerMessage) => void;

/**
 * Background side: runs one narration for the port's first `start` and relays
 * a failure as its message and kind. The run emits its own plan, chunks, and
 * `end`; it is aborted when the overlay disconnects.
 */
export function serveNarrationPort(
  port: NarrationPort,
  run: (
    request: NarrationRequest,
    signal: AbortSignal,
    emit: NarrationEmit,
  ) => Promise<void>,
): void {
  const abort = new AbortController();
  let started = false;
  const emit: NarrationEmit = (message) => {
    if (abort.signal.aborted) return;
    try {
      port.postMessage(message);
    } catch {
      abort.abort();
    }
  };
  const onDisconnect = () => {
    abort.abort();
    port.onDisconnect.removeListener(onDisconnect);
  };
  port.onDisconnect.addListener(onDisconnect);
  port.onMessage.addListener((message: unknown) => {
    const msg = message as Partial<NarrationClientMessage> | null;
    if (msg?.type !== 'start' || started) return;
    started = true;
    const request = parseNarrationRequest(msg.request);
    if (!request) {
      emit({ type: 'error', message: 'Invalid narration request', kind: 'fault' });
      return;
    }
    void run(request, abort.signal, emit).catch((error: unknown) => {
      emit({
        type: 'error',
        message: errorMessage(error, 'Failed to stream audio'),
        kind: briefErrorKind(error),
      });
    });
  });
}
