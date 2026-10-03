import { managedErrorData } from '../convex/lib/errors';
import { resolveLlmAuth, type LlmAuth } from './auth';
import { RelayedError, SetupError } from './errors';
import type { OutputLanguage } from './languages';
import { activeModels } from './models';
import {
  addMoneyLine,
  getMoneyEvent,
  startMoneySession,
  usageToLineItem,
  type MoneyAuthMode,
} from './money';
import {
  narrationCacheKey,
  NarrationCacheMissingError,
  type NarrationCache,
  type NarrationKeyInput,
} from './narrationCache';
import type { NarrationEmit, NarrationRequest } from './narrationProtocol';
import { streamAudioChatPcm } from './openai';
import {
  bytesToBase64,
  PCM_BYTES_PER_SAMPLE,
  PCM_SAMPLE_RATE,
} from './pcmFormat';
import { concatPcmChunks } from './pcmPlayer';
import { prefetchInOrder } from './prefetch';
import { OpenAIError } from './providerError';
import { getSettings } from './storage';
import {
  buildNarratorInstructions,
  buildTtsChunks,
  lessonTtsChunks,
  scriptMessage,
} from './tts';
import type { ProviderUsage } from './usage';
import type {
  BriefResult,
  ManagedLifecycleEvent,
  ReportLength,
  Settings,
  VoiceId,
} from './types';

/** Cached audio goes out in two-second slices, like a fast download. */
const REPLAY_SLICE_BYTES = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 2;

export interface NarrationPlan extends NarrationKeyInput {
  /** Later segments to download while the current one streams. */
  prefetch: number;
}

function narrationAuthMode(settings: Settings): NarrationKeyInput['authMode'] {
  if (settings.providerMode === 'managed') return 'managed';
  try {
    return resolveLlmAuth(settings).mode;
  } catch (error) {
    throw new SetupError(
      error instanceof Error ? error.message : 'No provider key for narration',
    );
  }
}

/** What the overlay narrates for a saved brief, read from the brief and settings alone. */
export function narrationPlan(
  brief: BriefResult,
  settings: Settings,
): NarrationPlan {
  const lesson = brief.format === 'chalkboard' ? brief.lesson : undefined;
  const outputLanguage = brief.outputLanguage ?? settings.outputLanguage;
  return {
    texts: lesson ? lessonTtsChunks(lesson) : buildTtsChunks(brief.script),
    voice: settings.voice,
    model: activeModels(settings).tts,
    instructions: buildNarratorInstructions({
      articleType: brief.articleType?.type,
      chalkboard: Boolean(lesson),
      outputLanguage,
    }),
    articleType: brief.articleType?.type ?? null,
    outputLanguage,
    authMode: narrationAuthMode(settings),
    prefetch: lesson ? 2 : 0,
  };
}

export async function isNarrationCached(
  brief: BriefResult,
  settings: Settings,
  cache: Pick<NarrationCache, 'has'>,
): Promise<boolean> {
  try {
    return await cache.has(await narrationCacheKey(narrationPlan(brief, settings)));
  } catch {
    return false;
  }
}

export interface NarrationSegmentOptions {
  auth: LlmAuth;
  model: string;
  voice: VoiceId;
  text: string;
  instructions: string;
  signal: AbortSignal;
  onUsage: (usage: ProviderUsage) => Promise<void>;
}

export function streamNarrationSegment(
  options: NarrationSegmentOptions,
): AsyncGenerator<Uint8Array, void, unknown> {
  return streamAudioChatPcm({
    auth: options.auth,
    model: options.model,
    voice: options.voice,
    input: scriptMessage(options.text),
    instructions: options.instructions,
    signal: options.signal,
    onUsage: options.onUsage,
  });
}

export interface NarrationDeps {
  /** The brief saved for the requesting tab and page. */
  loadBrief(): Promise<BriefResult | null>;
  loadSettings(): Promise<Settings>;
  cache: Pick<NarrationCache, 'lookup' | 'put'>;
  /** The managed session's key while it's live; null once the session ended. */
  managedAuth(sessionId: string): Promise<LlmAuth | null>;
  /** The tab's managed session, reopened as a paid replay when its key is gone. */
  acquireManaged(
    brief: BriefResult,
    settings: Settings,
  ): Promise<{ sessionId: string; auth: LlmAuth }>;
  openSegment(options: NarrationSegmentOptions): AsyncIterable<Uint8Array>;
  /** Adds a TTS spend line; returns the spend session it went to. */
  attachUsage(
    usage: ProviderUsage,
    moneySessionId: string | null,
    brief: BriefResult,
  ): Promise<string | null>;
  onCacheError?(error: unknown): void;
}

async function narrationAuth(
  request: NarrationRequest,
  brief: BriefResult,
  settings: Settings,
  emit: NarrationEmit,
  deps: NarrationDeps,
): Promise<LlmAuth> {
  if (settings.providerMode !== 'managed') return resolveLlmAuth(settings);
  if (request.managedSessionId) {
    const auth = await deps.managedAuth(request.managedSessionId);
    if (auth) return auth;
    // An ended session's key is dropped here and disabled at the provider.
    throw new OpenAIError('This listening session has ended', 401);
  }
  const acquired = await deps.acquireManaged(brief, settings);
  emit({ type: 'managed', sessionId: acquired.sessionId });
  return acquired.auth;
}

/**
 * One narration of the tab's saved brief: replayed from the cache when the
 * whole narration is saved, otherwise streamed from the provider (and saved
 * once every segment has downloaded).
 */
export async function runNarration(
  request: NarrationRequest,
  signal: AbortSignal,
  emit: NarrationEmit,
  deps: NarrationDeps,
): Promise<void> {
  const brief = await deps.loadBrief();
  if (!brief || (brief.moneySessionId ?? null) !== request.briefId) {
    throw new RelayedError(
      'This brief is no longer saved for the page',
      'fault',
    );
  }
  const settings = await deps.loadSettings();
  const plan = narrationPlan(brief, settings);
  const key = await narrationCacheKey(plan);
  const cached = await deps.cache.lookup(key).catch(() => null);
  const hit = cached?.segments === plan.texts.length ? cached : null;
  if (signal.aborted) return;
  emit({ type: 'plan', segments: plan.texts.length, cached: Boolean(hit) });

  if (hit) {
    for (let index = 0; index < hit.segments; index++) {
      let pcm: Uint8Array;
      try {
        pcm = await hit.read(index);
      } catch (error) {
        throw error instanceof NarrationCacheMissingError
          ? new RelayedError(error.message, 'transient')
          : error;
      }
      if (signal.aborted) return;
      for (let offset = 0; offset < pcm.byteLength; offset += REPLAY_SLICE_BYTES) {
        emit({
          type: 'chunk',
          index,
          pcm: bytesToBase64(pcm.subarray(offset, offset + REPLAY_SLICE_BYTES)),
        });
      }
      emit({ type: 'segment_done', index });
    }
    emit({ type: 'end' });
    return;
  }

  const auth = await narrationAuth(request, brief, settings, emit, deps);
  if (signal.aborted) return;

  let moneySessionId = request.moneySessionId;
  const downloaded: Uint8Array[][] = plan.texts.map(() => []);
  const events = prefetchInOrder(
    plan.texts.length,
    (index) =>
      deps.openSegment({
        auth,
        model: plan.model,
        voice: settings.voice,
        text: plan.texts[index]!,
        instructions: plan.instructions,
        signal,
        onUsage: async (usage) => {
          const used = await deps.attachUsage(usage, moneySessionId, brief);
          if (used && used !== moneySessionId) {
            moneySessionId = used;
            emit({ type: 'money', sessionId: used });
          }
        },
      }),
    plan.prefetch,
  );
  for await (const event of events) {
    if (signal.aborted) return;
    if ('done' in event) {
      emit({ type: 'segment_done', index: event.index });
      continue;
    }
    downloaded[event.index]!.push(event.chunk);
    emit({ type: 'chunk', index: event.index, pcm: bytesToBase64(event.chunk) });
  }
  emit({ type: 'end' });

  try {
    await deps.cache.put(key, downloaded.map(concatPcmChunks));
  } catch (error) {
    deps.onCacheError?.(error);
  }
}

/**
 * TTS spend goes to the brief's spend session while it's open, otherwise to a
 * new replay session. The background twin of the overlay's former ledger code.
 */
export async function attachNarrationUsage(
  usage: ProviderUsage,
  moneySessionId: string | null,
  brief: BriefResult,
): Promise<string | null> {
  const latest = await getSettings();

  let authMode: MoneyAuthMode;
  if (latest.providerMode === 'managed') {
    authMode = 'managed';
  } else {
    try {
      authMode = resolveLlmAuth(latest).mode;
    } catch {
      return moneySessionId;
    }
  }

  let sessionId = moneySessionId;
  const existing = sessionId ? await getMoneyEvent(sessionId) : null;
  if (!existing || existing.outcome !== 'open') {
    sessionId = await startMoneySession({
      kind: 'tts_replay',
      reportLength: brief.reportLength ?? latest.reportLength,
      voice: latest.voice,
      outputLanguage: latest.outputLanguage,
      authMode,
    });
  }
  if (!sessionId) return moneySessionId;

  await addMoneyLine(
    sessionId,
    usageToLineItem('tts', activeModels(latest).tts, usage),
  );
  return sessionId;
}

export interface ManagedNarrationRequest {
  sessionId: string;
  estimatedSeconds: number;
  reportLength: ReportLength;
  voice: VoiceId;
  outputLanguage: OutputLanguage;
}

export interface ManagedSessionDeps {
  sessionAuth(sessionId: string): Promise<LlmAuth | null>;
  report(sessionId: string, event: ManagedLifecycleEvent): Promise<void>;
  openReplay(dims: {
    reportLength: ReportLength;
    voice: VoiceId;
    outputLanguage: OutputLanguage;
  }): Promise<{ sessionId: string; auth: LlmAuth }>;
  sleep?(ms: number): Promise<void>;
}

export type ManagedNarrationSession =
  | { sessionId: string; auth: LlmAuth }
  | { sessionId: null; auth: null };

/**
 * Reuses the session while its key is live. Otherwise closes it and opens a
 * paid replay session, unless the whole narration is cached: replaying saved
 * audio needs no provider and no credit.
 */
export async function ensureManagedNarrationSession(
  request: ManagedNarrationRequest,
  cached: boolean,
  deps: ManagedSessionDeps,
): Promise<ManagedNarrationSession> {
  const live = await deps.sessionAuth(request.sessionId);
  if (live) return { sessionId: request.sessionId, auth: live };

  try {
    await deps.report(request.sessionId, {
      type: 'aborted',
      playbackSeconds: 0,
    });
  } catch {
    // A completed or expired session may already be terminal.
  }
  if (cached) return { sessionId: null, auth: null };

  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let replay: { sessionId: string; auth: LlmAuth } | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      replay = await deps.openReplay({
        reportLength: request.reportLength,
        voice: request.voice,
        outputLanguage: request.outputLanguage,
      });
      break;
    } catch (error) {
      lastError = error;
      if (
        managedErrorData(error)?.code !== 'session_in_progress' ||
        attempt === 2
      ) {
        throw error;
      }
      await sleep(500 * (attempt + 1));
    }
  }
  if (!replay) throw lastError;
  await deps.report(replay.sessionId, {
    type: 'script_ready',
    estimatedSeconds: request.estimatedSeconds,
  });
  return replay;
}
