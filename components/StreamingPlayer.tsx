import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import {
  briefErrorKind,
  errorMeterLabel,
  type BriefErrorKind,
} from '../utils/errors';
import { NARRATION_PORT, streamNarration } from '../utils/narrationProtocol';
import { PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE } from '../utils/pcmFormat';
import {
  concatPcmChunks,
  pcmDurationSeconds,
  PcmStreamPlayer,
} from '../utils/pcmPlayer';
import { buildTtsChunks } from '../utils/tts';
import type { ChalkTimeline } from '../utils/chalk/types';
import type { OutputLanguage } from '../utils/languages';
import type { NewsReportScript, VoiceId } from '../utils/types';
import { MutedIcon, PauseIcon, PlayIcon, VolumeIcon } from './TransportIcons';

interface StreamingPlayerProps {
  script: NewsReportScript;
  /** The brief being narrated; the background narrates only the tab's saved brief. */
  briefId: string | null;
  /** Bumped when narration must restart on different credentials. */
  authRevision: number;
  /** Managed session to spend through; null when narration didn't need one yet. */
  managedSessionId: string | null;
  /** Spend session for TTS lines; moved to a replay session once the brief's closes. */
  moneySessionRef: MutableRefObject<string | null>;
  /** Narration opened this managed session. */
  onManagedSession?: (sessionId: string) => void;
  model: string;
  voice: VoiceId;
  outputLanguage: OutputLanguage;
  onPlaying?: () => void;
  onDone?: (playbackSeconds: number) => void;
  onError?: (
    message: string,
    playbackSeconds: number,
    kind: BriefErrorKind,
  ) => void;
  onAbort?: (playbackSeconds: number) => void;
  /** Keep the transport mounted but paused and out of the way, so another tape can take the face. */
  held?: boolean;
  /**
   * A saved listen is on screen. Don't start audio until play is confirmed,
   * and let that play click open the menu first.
   */
  suspended?: boolean;
  menuOpen?: boolean;
  onPlayRequest?: () => void;
  /** Narration requests in order; defaults to the script split for TTS. */
  chunks?: string[];
  /** Media-time span of each chunk, re-published as downloads progress. */
  onChunkTimeline?: (timeline: ChalkTimeline) => void;
  /** Filled with a reader for the playhead (seconds), for per-frame sync. */
  clockRef?: MutableRefObject<(() => number) | null>;
  /** The full narration PCM once every chunk has downloaded; null whenever the cache resets. */
  onNarration?: (pcm: Uint8Array | null) => void;
}

type TransportPhase = 'loading' | 'playing' | 'paused' | 'ready';

/** Enable scrub once we have ~250ms of PCM (near start-buffer). */
const SCRUB_ENABLE_SECONDS = 0.25;
const BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function bytesToSeconds(bytes: number): number {
  return bytes / BYTES_PER_SECOND;
}

export function StreamingPlayer({
  script,
  briefId,
  authRevision,
  managedSessionId,
  moneySessionRef,
  onManagedSession,
  model,
  voice,
  outputLanguage,
  onPlaying,
  onDone,
  onError,
  onAbort,
  held = false,
  suspended = false,
  menuOpen = false,
  onPlayRequest,
  chunks,
  onChunkTimeline,
  clockRef,
  onNarration,
}: StreamingPlayerProps) {
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const volumeRef = useRef(0.85);
  const unmuteVolumeRef = useRef(0.85);
  const cacheChunksRef = useRef<Uint8Array[]>([]);
  const cacheBytesRef = useRef(0);
  const cachePcmRef = useRef<Uint8Array | null>(null);
  const cacheCompleteRef = useRef(false);
  const liveScheduleRef = useRef(true);
  const phaseRef = useRef<TransportPhase>(suspended ? 'ready' : 'loading');
  const streamingRef = useRef(false);
  const scrubbingRef = useRef(false);
  const volumeDraggingRef = useRef(false);
  const bufferedSecondsRef = useRef(0);
  const durationRef = useRef(0);
  const volumeRailRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef(false);

  const onPlayingRef = useRef(onPlaying);
  const onDoneRef = useRef(onDone);
  const onErrorRef = useRef(onError);
  const onAbortRef = useRef(onAbort);
  const onManagedSessionRef = useRef(onManagedSession);
  const onChunkTimelineRef = useRef(onChunkTimeline);
  const onNarrationRef = useRef(onNarration);

  const scriptKey = `${script.headline}\n${script.lede}\n${script.segments.join('\n')}\n${chunks?.join('\n') ?? ''}`;
  const scriptRef = useRef(script);
  const briefIdRef = useRef(briefId);
  const managedSessionIdRef = useRef(managedSessionId);
  const chunksRef = useRef(chunks);

  const estimatedSeconds = Math.max(1, script.estimatedSeconds || 120);

  const [phase, setPhase] = useState<TransportPhase>(suspended ? 'ready' : 'loading');
  const [needsGesture, setNeedsGesture] = useState(false);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<BriefErrorKind>('fault');
  const [volume, setVolume] = useState(0.85);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const [canScrub, setCanScrub] = useState(false);
  const [duration, setDuration] = useState(estimatedSeconds);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [position, setPosition] = useState(0);

  const positionRef = useRef(0);

  // Before any effect, so effects and the callbacks they start see this render.
  useLayoutEffect(() => {
    onChunkTimelineRef.current = onChunkTimeline;
    onNarrationRef.current = onNarration;
    onPlayingRef.current = onPlaying;
    onDoneRef.current = onDone;
    onErrorRef.current = onError;
    onAbortRef.current = onAbort;
    onManagedSessionRef.current = onManagedSession;
    chunksRef.current = chunks;
    scriptRef.current = script;
    briefIdRef.current = briefId;
    managedSessionIdRef.current = managedSessionId;
    durationRef.current = duration;
    bufferedSecondsRef.current = bufferedSeconds;
    positionRef.current = position;
  });

  useEffect(() => {
    if (!clockRef) return;
    const read = () => {
      const player = playerRef.current;
      if (player && phaseRef.current === 'playing' && !scrubbingRef.current) {
        return player.getCurrentTime();
      }
      return positionRef.current;
    };
    clockRef.current = read;
    return () => {
      if (clockRef.current === read) clockRef.current = null;
    };
  }, [clockRef]);

  const setTransportPhase = useCallback((next: TransportPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const updateBufferFromBytes = useCallback(
    (totalBytes: number) => {
      const buffered = bytesToSeconds(totalBytes);
      bufferedSecondsRef.current = buffered;
      setBufferedSeconds(buffered);
      if (buffered >= SCRUB_ENABLE_SECONDS) {
        setCanScrub(true);
      }

      if (!cacheCompleteRef.current) {
        const nextDuration = Math.max(estimatedSeconds, buffered);
        durationRef.current = nextDuration;
        setDuration(nextDuration);
        playerRef.current?.setDuration(nextDuration);
      }
    },
    [estimatedSeconds],
  );

  const clearCache = useCallback(() => {
    cacheChunksRef.current = [];
    cacheBytesRef.current = 0;
    cachePcmRef.current = null;
    cacheCompleteRef.current = false;
    liveScheduleRef.current = true;
    bufferedSecondsRef.current = 0;
    setCanScrub(false);
    setBufferedSeconds(0);
    setDuration(estimatedSeconds);
    durationRef.current = estimatedSeconds;
    setPosition(0);
    onNarrationRef.current?.(null);
  }, [estimatedSeconds]);

  const markCacheComplete = useCallback(() => {
    const pcm = concatPcmChunks(cacheChunksRef.current);
    cachePcmRef.current = pcm;
    cacheCompleteRef.current = true;
    const secs = pcmDurationSeconds(pcm);
    bufferedSecondsRef.current = secs;
    setBufferedSeconds(secs);
    durationRef.current = secs;
    setDuration(secs);
    setCanScrub(secs > 0);
    playerRef.current?.setDuration(secs);
    onNarrationRef.current?.(pcm.byteLength > 0 ? pcm : null);
  }, []);

  const getCachedPcm = useCallback(() => {
    if (cacheCompleteRef.current && cachePcmRef.current) {
      return cachePcmRef.current;
    }
    const pcm = concatPcmChunks(cacheChunksRef.current);
    if (cacheCompleteRef.current) {
      cachePcmRef.current = pcm;
    }
    return pcm;
  }, []);

  useEffect(() => {
    volumeRef.current = volume;
    playerRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    if (!held) return;
    const player = playerRef.current;
    if (!player || phaseRef.current !== 'playing') return;
    void player.suspend().then(() => {
      if (phaseRef.current !== 'playing') return;
      setPosition(player.getCurrentTime());
      setTransportPhase('paused');
    });
  }, [held, setTransportPhase]);

  // Long-lived player for this mount
  useEffect(() => {
    const player = new PcmStreamPlayer();
    playerRef.current = player;
    player.setVolume(volumeRef.current);

    player.onStart = () => {
      setNeedsGesture(false);
      setTransportPhase('playing');
      onPlayingRef.current?.();
    };
    player.onAutoplayBlocked = () => {
      setNeedsGesture(true);
      setTransportPhase('ready');
    };
    player.onEnded = () => {
      const endAt = Math.max(
        player.duration,
        player.getCurrentTime(),
        bufferedSecondsRef.current,
      );
      setPosition(endAt);
      if (!cacheCompleteRef.current || streamingRef.current) {
        setTransportPhase('loading');
        return;
      }
      setTransportPhase('ready');
      terminalRef.current = true;
      onDoneRef.current?.(endAt);
    };

    return () => {
      if (!terminalRef.current) {
        onAbortRef.current?.(player.getCurrentTime());
      }
      abortRef.current?.abort();
      player.stop();
      if (playerRef.current === player) {
        playerRef.current = null;
      }
    };
  }, [setTransportPhase]);

  // Scrubber / playhead updates while playing
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'paused') return;

    let frame = 0;
    const tick = () => {
      const player = playerRef.current;
      if (player && !scrubbingRef.current) {
        setPosition(player.getCurrentTime());
      }
      if (phaseRef.current === 'playing') {
        frame = requestAnimationFrame(tick);
      }
    };

    if (phase === 'playing') {
      frame = requestAnimationFrame(tick);
    } else if (phase === 'paused' && playerRef.current) {
      setPosition(playerRef.current.getCurrentTime());
    }

    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const playFromCache = useCallback(
    async (offsetSeconds = 0, options?: { autoplay?: boolean }) => {
      const player = playerRef.current;
      if (!player || cacheBytesRef.current === 0) return;

      const autoplay = options?.autoplay ?? true;
      // Seeking switches off live scheduling; download may continue into cache
      liveScheduleRef.current = false;

      const pcm = getCachedPcm();
      if (pcm.byteLength === 0) {
        clearCache();
        return;
      }

      const buffered = pcmDurationSeconds(pcm);
      const clamped = Math.min(Math.max(0, offsetSeconds), Math.max(0, buffered - 0.05));

      if (cacheCompleteRef.current) {
        durationRef.current = buffered;
        setDuration(buffered);
        player.setDuration(buffered);
      }

      setCanScrub(true);
      setPosition(clamped);
      setError('');
      setNeedsGesture(false);
      setTransportPhase(autoplay ? 'loading' : phaseRef.current);

      try {
        await player.playBuffer(pcm, clamped);
        if (!autoplay) {
          await player.suspend();
          setPosition(clamped);
          setTransportPhase(
            phaseRef.current === 'ready' ? 'ready' : 'paused',
          );
          return;
        }
        if (
          player.ended &&
          cacheCompleteRef.current &&
          !streamingRef.current &&
          phaseRef.current !== 'playing'
        ) {
          setPosition(player.duration || buffered);
          setTransportPhase('ready');
          terminalRef.current = true;
          onDoneRef.current?.(player.duration || buffered);
        }
      } catch (err) {
        setNeedsGesture(true);
        setTransportPhase('ready');
        console.error(err);
      }
    },
    [clearCache, getCachedPcm, setTransportPhase],
  );

  const startStream = useCallback(async () => {
    const player = playerRef.current;
    if (!player) return;

    const runId = ++runIdRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    clearCache();
    liveScheduleRef.current = true;
    player.resetPlayback();
    player.setDuration(estimatedSeconds);
    durationRef.current = estimatedSeconds;
    setDuration(estimatedSeconds);
    streamingRef.current = true;
    terminalRef.current = false;
    setError('');
    setNeedsGesture(false);
    setTransportPhase('loading');

    const texts = chunksRef.current ?? buildTtsChunks(scriptRef.current);
    const starts: (number | null)[] = texts.map(() => null);
    const ends: (number | null)[] = texts.map(() => null);
    const publishTimeline = () =>
      onChunkTimelineRef.current?.({ starts: [...starts], ends: [...ends] });
    publishTimeline();

    try {
      await player.resume().catch(() => undefined);

      let current = -1;
      const events = streamNarration({
        connect: () => browser.runtime.connect({ name: NARRATION_PORT }),
        request: {
          briefId: briefIdRef.current,
          moneySessionId: moneySessionRef.current,
          managedSessionId: managedSessionIdRef.current,
        },
        expectedSegments: texts.length,
        signal: abort.signal,
        onMoneySession: (sessionId) => {
          moneySessionRef.current = sessionId;
        },
        onManagedSession: (sessionId) => {
          managedSessionIdRef.current = sessionId;
          onManagedSessionRef.current?.(sessionId);
        },
      });
      for await (const event of events) {
        if (abort.signal.aborted || runId !== runIdRef.current) return;

        if (event.index !== current) {
          current = event.index;
          if (current > 0 && liveScheduleRef.current) {
            player.prepareNextSegment();
          }
          starts[current] = bytesToSeconds(cacheBytesRef.current);
          publishTimeline();
        }

        if ('done' in event) {
          ends[current] = bytesToSeconds(cacheBytesRef.current);
          publishTimeline();
          if (current === texts.length - 1) {
            markCacheComplete();
            streamingRef.current = false;
            if (liveScheduleRef.current) {
              player.markStreamComplete();
            }
          }
          continue;
        }

        const copy = event.chunk.slice();
        cacheChunksRef.current.push(copy);
        cacheBytesRef.current += copy.byteLength;
        cachePcmRef.current = null;
        updateBufferFromBytes(cacheBytesRef.current);

        if (liveScheduleRef.current) {
          await player.feed(copy);
        }
      }

      if (abort.signal.aborted || runId !== runIdRef.current) return;

      if (!cacheCompleteRef.current) {
        markCacheComplete();
      }
      streamingRef.current = false;

      if (liveScheduleRef.current && !player.hasStarted) {
        await player.resume();
        player.markStreamComplete();
      }
    } catch (err) {
      if (abort.signal.aborted || runId !== runIdRef.current) return;
      streamingRef.current = false;
      clearCache();
      const message =
        err instanceof Error ? err.message : 'Failed to stream audio';
      const kind = briefErrorKind(err);
      const playbackSeconds = player.getCurrentTime();
      setError(message);
      setErrorKind(kind);
      setTransportPhase('ready');
      terminalRef.current = true;
      onErrorRef.current?.(message, playbackSeconds, kind);
      player.resetPlayback();
    }
  }, [
    clearCache,
    estimatedSeconds,
    markCacheComplete,
    moneySessionRef,
    setTransportPhase,
    updateBufferFromBytes,
  ]);

  const restartStream = useEffectEvent(() => {
    void startStream();
  });

  // New script / model / voice / key → fresh stream (invalidates cache).
  // A saved listen stays quiet until play is confirmed.
  useEffect(() => {
    if (suspended) return;
    restartStream();

    return () => {
      abortRef.current?.abort();
      runIdRef.current += 1;
      streamingRef.current = false;
    };
  }, [scriptKey, authRevision, model, voice, outputLanguage, suspended]);

  const toggle = async () => {
    const player = playerRef.current;
    if (!player) return;

    try {
      if (phaseRef.current === 'playing') {
        await player.suspend();
        setPosition(player.getCurrentTime());
        setTransportPhase('paused');
        return;
      }

      if (phaseRef.current === 'paused') {
        await player.resume();
        if (player.playing) {
          setNeedsGesture(false);
          setTransportPhase('playing');
          onPlayingRef.current?.();
        } else {
          setNeedsGesture(true);
        }
        return;
      }

      // ready — play from scrub position within buffer
      if (cacheBytesRef.current > 0) {
        const end = cacheCompleteRef.current
          ? duration
          : bufferedSecondsRef.current;
        const atEnd = end > 0 && position >= end - 0.15;
        await playFromCache(atEnd ? 0 : position, { autoplay: true });
        return;
      }

      if (streamingRef.current) {
        await player.resume();
        if (player.playing) {
          setNeedsGesture(false);
          setTransportPhase('playing');
          onPlayingRef.current?.();
        }
        return;
      }

      await startStream();
    } catch (err) {
      setNeedsGesture(true);
      console.error(err);
    }
  };

  const scrubRef = useRef<HTMLDivElement | null>(null);

  const valueFromPointer = (clientX: number) => {
    const el = scrubRef.current;
    if (!el || durationRef.current <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * durationRef.current;
  };

  const clampToBuffered = (seconds: number) => {
    const max = Math.max(0, bufferedSecondsRef.current);
    return Math.min(Math.max(0, seconds), max);
  };

  const onScrubPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canScrub || durationRef.current <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubbingRef.current = true;
    setPosition(clampToBuffered(valueFromPointer(event.clientX)));
  };

  const onScrubPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    setPosition(clampToBuffered(valueFromPointer(event.clientX)));
  };

  const onScrubPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    const value = clampToBuffered(valueFromPointer(event.clientX));
    setPosition(value);

    const current = phaseRef.current;
    if (current === 'ready') {
      // YouTube: scrub while stopped only moves the playhead
      return;
    }

    void playFromCache(value, { autoplay: current !== 'paused' });
  };

  const seekByStep = (delta: number) => {
    if (!canScrub) return;
    const next = clampToBuffered(position + delta);
    setPosition(next);
    if (phaseRef.current === 'ready') return;
    void playFromCache(next, { autoplay: phaseRef.current !== 'paused' });
  };

  const timeProgress =
    duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const bufferedProgress =
    duration > 0 ? Math.min(1, Math.max(0, bufferedSeconds / duration)) : 0;

  const label = error
    ? errorMeterLabel(errorKind)
    : needsGesture
      ? 'Play'
      : phase === 'loading' && !canScrub
        ? 'Load…'
        : canScrub
          ? `${formatTime(position)} / ${formatTime(duration)}`
          : '';

  const showPlaying = phase === 'playing';
  const playedPct = Math.max(timeProgress * 100, 0);
  const bufferedPct = Math.max(bufferedProgress * 100, canScrub ? 0 : 8);

  const volumeFromPointer = (clientX: number) => {
    const el = volumeRailRef.current;
    if (!el) return volume;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const toggleMute = () => {
    if (volume > 0) {
      unmuteVolumeRef.current = volume;
      setVolume(0);
    } else {
      setVolume(unmuteVolumeRef.current || 0.85);
    }
  };

  return (
    <div className="player" hidden={held}>
      <div className="player__bar">
        <button
          type="button"
          className={`player__icon-btn${showPlaying ? ' player__icon-btn--live' : ' player__icon-btn--armed'}`}
          onClick={() => {
            const current = phaseRef.current;
            if (current === 'playing' || current === 'paused') {
              void toggle();
              return;
            }
            if (onPlayRequest) {
              onPlayRequest();
              return;
            }
            void toggle();
          }}
          aria-label={
            showPlaying
              ? 'Pause'
              : onPlayRequest
                ? menuOpen
                  ? 'Play the saved brief'
                  : 'Choose brief or chalkboard'
                : 'Play'
          }
          aria-expanded={onPlayRequest ? menuOpen : undefined}
          aria-haspopup={onPlayRequest ? 'true' : undefined}
        >
          {showPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div
          className={`player__volume${volumeDragging ? ' player__volume--open' : ''}`}
        >
          <button
            type="button"
            className="player__volume-btn"
            onClick={toggleMute}
            aria-label={volume === 0 ? 'Unmute' : 'Mute'}
          >
            {volume === 0 ? <MutedIcon /> : <VolumeIcon />}
          </button>
          <div
            ref={volumeRailRef}
            className="player__volume-scrub"
            role="slider"
            tabIndex={0}
            aria-label="Volume"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={volume}
            aria-valuetext={`${Math.round(volume * 100)}%`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              volumeDraggingRef.current = true;
              setVolumeDragging(true);
              setVolume(volumeFromPointer(e.clientX));
            }}
            onPointerMove={(e) => {
              if (!volumeDraggingRef.current) return;
              setVolume(volumeFromPointer(e.clientX));
            }}
            onPointerUp={() => {
              volumeDraggingRef.current = false;
              setVolumeDragging(false);
            }}
            onPointerCancel={() => {
              volumeDraggingRef.current = false;
              setVolumeDragging(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault();
                setVolume((v) => Math.max(0, v - 0.05));
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault();
                setVolume((v) => Math.min(1, v + 0.05));
              }
            }}
          >
            <div className="player__volume-rail">
              <div
                className="player__volume-fill"
                style={{ width: `${volume * 100}%` }}
              />
            </div>
            <div
              className="player__volume-thumb"
              style={{ left: `${volume * 100}%` }}
              aria-hidden="true"
            />
          </div>
        </div>
        <div
          ref={scrubRef}
          className={`player__scrub${canScrub ? ' player__scrub--active' : ''}${phase === 'loading' && !canScrub ? ' player__scrub--loading' : ''}`}
          role={canScrub ? 'slider' : 'progressbar'}
          tabIndex={canScrub ? 0 : -1}
          aria-label={canScrub ? 'Seek' : 'Progress'}
          aria-valuemin={0}
          aria-valuemax={canScrub ? duration : 1}
          aria-valuenow={canScrub ? position : bufferedProgress}
          onPointerDown={canScrub ? onScrubPointerDown : undefined}
          onPointerMove={canScrub ? onScrubPointerMove : undefined}
          onPointerUp={canScrub ? onScrubPointerUp : undefined}
          onPointerCancel={canScrub ? onScrubPointerUp : undefined}
          onKeyDown={
            canScrub
              ? (e) => {
                  const step = Math.max(duration / 20, 1);
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    seekByStep(-step);
                  } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    seekByStep(step);
                  }
                }
              : undefined
          }
        >
          <div className="player__scrub-rail">
            <div
              className="player__scrub-buffered"
              style={{ width: `${bufferedPct}%` }}
            />
            <div
              className="player__scrub-fill"
              style={{ width: `${canScrub ? playedPct : bufferedPct}%` }}
            />
          </div>
          {canScrub && (
            <div
              className="player__scrub-thumb"
              style={{ left: `${playedPct}%` }}
              aria-hidden="true"
            />
          )}
        </div>
        <span
          className={`player__label${error ? ' player__label--error' : ''}${!label ? ' player__label--empty' : ''}`}
        >
          {label || '\u00a0'}
        </span>
      </div>
    </div>
  );
}
