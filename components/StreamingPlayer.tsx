import { useCallback, useEffect, useRef, useState } from 'react';
import { authCacheKey, type LlmAuth } from '../utils/auth';
import { PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE } from '../utils/openai';
import {
  concatPcmChunks,
  pcmDurationSeconds,
  PcmStreamPlayer,
} from '../utils/pcmPlayer';
import { buildTtsChunks, streamSegmentPcm } from '../utils/tts';
import type { ProviderUsage } from '../utils/usage';
import type { NewsReportScript, OutputLanguage, VoiceId } from '../utils/types';
import { PauseIcon, PlayIcon, VolumeIcon } from './TransportIcons';

interface StreamingPlayerProps {
  script: NewsReportScript;
  auth: LlmAuth;
  voice: VoiceId;
  outputLanguage: OutputLanguage;
  autoPlay?: boolean;
  onPlaying?: () => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  /** Fired once per TTS API segment that actually spent. Cache replay does not fire. */
  onUsage?: (usage: ProviderUsage) => void | Promise<void>;
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
  auth,
  voice,
  outputLanguage,
  autoPlay = true,
  onPlaying,
  onDone,
  onError,
  onUsage,
}: StreamingPlayerProps) {
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const volumeRef = useRef(0.85);
  const cacheChunksRef = useRef<Uint8Array[]>([]);
  const cacheBytesRef = useRef(0);
  const cachePcmRef = useRef<Uint8Array | null>(null);
  const cacheCompleteRef = useRef(false);
  const liveScheduleRef = useRef(true);
  const phaseRef = useRef<TransportPhase>('loading');
  const streamingRef = useRef(false);
  const scrubbingRef = useRef(false);
  const volumeDraggingRef = useRef(false);
  const bufferedSecondsRef = useRef(0);
  const durationRef = useRef(0);
  const volumeRailRef = useRef<HTMLDivElement | null>(null);

  const onPlayingRef = useRef(onPlaying);
  const onDoneRef = useRef(onDone);
  const onErrorRef = useRef(onError);
  const onUsageRef = useRef(onUsage);
  onPlayingRef.current = onPlaying;
  onDoneRef.current = onDone;
  onErrorRef.current = onError;
  onUsageRef.current = onUsage;

  const scriptKey = `${script.headline}\n${script.lede}\n${script.segments.join('\n')}`;
  const authKey = authCacheKey(auth);
  const scriptRef = useRef(script);
  const authRef = useRef(auth);
  const voiceRef = useRef(voice);
  const outputLanguageRef = useRef(outputLanguage);
  scriptRef.current = script;
  authRef.current = auth;
  voiceRef.current = voice;
  outputLanguageRef.current = outputLanguage;

  const estimatedSeconds = Math.max(1, script.estimatedSeconds || 120);

  const [phase, setPhase] = useState<TransportPhase>('loading');
  const [needsGesture, setNeedsGesture] = useState(false);
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(0.85);
  const [canScrub, setCanScrub] = useState(false);
  const [duration, setDuration] = useState(estimatedSeconds);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [position, setPosition] = useState(0);

  durationRef.current = duration;
  bufferedSecondsRef.current = bufferedSeconds;

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
      setTransportPhase('ready');
      onDoneRef.current?.();
    };

    return () => {
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
        if (player.ended && phaseRef.current !== 'playing') {
          setPosition(player.duration || buffered);
          setTransportPhase('ready');
          onDoneRef.current?.();
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
    setError('');
    setNeedsGesture(false);
    setTransportPhase('loading');

    const texts = buildTtsChunks(scriptRef.current);

    try {
      await player.resume().catch(() => undefined);

      for (let i = 0; i < texts.length; i++) {
        if (abort.signal.aborted || runId !== runIdRef.current) return;

        if (i > 0 && liveScheduleRef.current) {
          player.prepareNextSegment();
        }

        const text = texts[i]!;
        for await (const chunk of streamSegmentPcm({
          auth: authRef.current,
          voice: voiceRef.current,
          outputLanguage: outputLanguageRef.current,
          text,
          signal: abort.signal,
          onUsage: (usage) => onUsageRef.current?.(usage),
        })) {
          if (abort.signal.aborted || runId !== runIdRef.current) return;

          const copy = chunk.slice();
          cacheChunksRef.current.push(copy);
          cacheBytesRef.current += copy.byteLength;
          cachePcmRef.current = null;
          updateBufferFromBytes(cacheBytesRef.current);

          if (liveScheduleRef.current) {
            await player.feed(copy);
          }
        }

        if (i === texts.length - 1) {
          markCacheComplete();
          streamingRef.current = false;
          if (liveScheduleRef.current) {
            player.markStreamComplete();
          }
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
      setError(message);
      setTransportPhase('ready');
      onErrorRef.current?.(message);
      player.resetPlayback();
    }
  }, [
    clearCache,
    estimatedSeconds,
    markCacheComplete,
    setTransportPhase,
    updateBufferFromBytes,
  ]);

  // New script / voice / key → fresh stream (invalidates cache)
  useEffect(() => {
    if (autoPlay) {
      void startStream();
    } else {
      clearCache();
      playerRef.current?.resetPlayback();
      setTransportPhase('ready');
    }

    return () => {
      abortRef.current?.abort();
      runIdRef.current += 1;
      streamingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptKey, authKey, voice, outputLanguage, autoPlay]);

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
    ? 'Fault'
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

  return (
    <div className="player">
      <div className="player__bar">
        <button
          type="button"
          className={`player__icon-btn${showPlaying ? ' player__icon-btn--live' : ' player__icon-btn--armed'}`}
          onClick={() => void toggle()}
          aria-label={showPlaying ? 'Pause' : 'Play'}
        >
          {showPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
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
      <div className="player__volume">
        <span className="player__volume-icon" aria-hidden="true">
          <VolumeIcon />
        </span>
        <div
          ref={volumeRailRef}
          className="player__volume-scrub"
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={volume}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            volumeDraggingRef.current = true;
            setVolume(volumeFromPointer(e.clientX));
          }}
          onPointerMove={(e) => {
            if (!volumeDraggingRef.current) return;
            setVolume(volumeFromPointer(e.clientX));
          }}
          onPointerUp={() => {
            volumeDraggingRef.current = false;
          }}
          onPointerCancel={() => {
            volumeDraggingRef.current = false;
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
    </div>
  );
}
