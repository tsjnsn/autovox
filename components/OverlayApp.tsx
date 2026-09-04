import { useCallback, useEffect, useRef, useState } from 'react';
import { ScriptPreview } from './ScriptPreview';
import { StreamingPlayer } from './StreamingPlayer';
import { PlayIcon } from './TransportIcons';
import { samePageUrl } from '../utils/briefState';
import { hasLlmAuth, resolveLlmAuth, type LlmAuth } from '../utils/auth';
import {
  addMoneyLine,
  finishMoneySession,
  getMoneyEvent,
  startMoneySession,
  usageToLineItem,
} from '../utils/money';
import { getSettings } from '../utils/storage';
import { TTS_MODEL } from '../utils/tts';
import type { ProviderUsage } from '../utils/usage';
import type {
  BriefPhase,
  BriefProgress,
  BriefResult,
  ExtensionMessage,
  Settings,
} from '../utils/types';

interface BriefStateResponse {
  progress: BriefProgress;
  result: BriefResult | null;
  running: boolean;
}

interface OverlayAppProps {
  onClose: () => void;
}

/** Short meter labels only — no idle instructional copy, no long headlines. */
function meterLabel(
  phase: BriefPhase,
  error: string,
  extracting: boolean,
): string {
  if (error) {
    const lower = error.toLowerCase();
    if (
      lower.includes('api key') ||
      lower.includes('connect') ||
      lower.includes('provider')
    ) {
      return 'No auth';
    }
    return 'Fault';
  }
  if (extracting) {
    switch (phase) {
      case 'extracting':
        return 'Extract…';
      case 'understanding':
        return 'Read…';
      case 'writing':
        return 'Write…';
      default:
        return 'Brief…';
    }
  }
  return '';
}

export function OverlayApp({ onClose }: OverlayAppProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<BriefPhase>('idle');
  const [extracting, setExtracting] = useState(false);
  const [result, setResult] = useState<BriefResult | null>(null);
  const [error, setError] = useState('');
  const [streamKey, setStreamKey] = useState(0);
  const [narrating, setNarrating] = useState(false);
  const [managedPlayerAuth, setManagedPlayerAuth] =
    useState<LlmAuth | null>(null);

  const hasScriptRef = useRef(false);
  hasScriptRef.current = Boolean(result);
  const moneySessionRef = useRef<string | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const managedRuntimeSessionRef = useRef<string | null>(null);
  settingsRef.current = settings;

  useEffect(() => {
    moneySessionRef.current = result?.moneySessionId ?? null;
  }, [result?.moneySessionId]);

  useEffect(() => {
    if (
      !result?.managedSessionId ||
      settings?.providerMode !== 'managed'
    ) {
      managedRuntimeSessionRef.current = null;
      setManagedPlayerAuth(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      const response = (await browser.runtime.sendMessage({
        type: 'GET_MANAGED_AUTH',
        sessionId: result.managedSessionId,
        estimatedSeconds: result.script.estimatedSeconds,
        reportLength:
          result.reportLength ?? settings.reportLength,
        voice: settings.voice,
        outputLanguage: settings.outputLanguage,
      })) as {
        ok: boolean;
        sessionId?: string;
        auth?: LlmAuth;
        error?: string;
      };
      if (cancelled) return;
      if (!response.ok || !response.sessionId || !response.auth) {
        setManagedPlayerAuth(null);
        setError(response.error ?? 'Managed listening is unavailable');
        setPhase('error');
        setNarrating(false);
        return;
      }
      managedRuntimeSessionRef.current = response.sessionId;
      setManagedPlayerAuth(response.auth);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    result?.managedSessionId,
    result?.script.estimatedSeconds,
    result?.reportLength,
    settings?.providerMode,
    settings?.reportLength,
    settings?.voice,
    settings?.outputLanguage,
  ]);

  const attachTtsUsage = useCallback(async (usage: ProviderUsage) => {
    const latest = settingsRef.current;
    if (!latest) return;

    let authMode: 'managed' | LlmAuth['mode'];
    if (latest.providerMode === 'managed') {
      authMode = 'managed';
    } else {
      try {
        authMode = resolveLlmAuth(latest).mode;
      } catch {
        return;
      }
    }

    let sessionId = moneySessionRef.current;
    const existing = sessionId ? await getMoneyEvent(sessionId) : null;
    if (!existing || existing.outcome !== 'open') {
      sessionId = await startMoneySession({
        kind: 'tts_replay',
        reportLength: latest.reportLength,
        voice: latest.voice,
        outputLanguage: latest.outputLanguage,
        authMode,
      });
      moneySessionRef.current = sessionId;
    }
    if (!sessionId) return;

    await addMoneyLine(
      sessionId,
      usageToLineItem('tts', TTS_MODEL, usage),
    );
  }, []);

  const finishTtsSession = useCallback(
    async (
      outcome: 'completed' | 'fault' | 'aborted',
      faultStage: 'tts' | 'none' = 'none',
    ) => {
      const sessionId = moneySessionRef.current;
      if (!sessionId) return;
      await finishMoneySession(sessionId, outcome, faultStage);
    },
    [],
  );

  const reportManagedPlayback = useCallback(
    async (
      event:
        | { type: 'playback_started' }
        | { type: 'completed'; playbackSeconds: number }
        | {
            type: 'fault';
            stage: 'tts';
            playbackSeconds: number;
          }
        | { type: 'aborted'; playbackSeconds: number },
    ) => {
      const sessionId = managedRuntimeSessionRef.current;
      if (!sessionId) return;
      const terminal =
        event.type === 'completed' ||
        event.type === 'fault' ||
        event.type === 'aborted';
      try {
        await browser.runtime.sendMessage({
          type: 'MANAGED_LIFECYCLE',
          sessionId,
          event,
        });
      } finally {
        if (
          terminal &&
          managedRuntimeSessionRef.current === sessionId
        ) {
          managedRuntimeSessionRef.current = null;
        }
      }
    },
    [],
  );

  const hasAuth = settings ? hasLlmAuth(settings) : null;
  const busy = extracting || narrating;
  const playerAuth =
    result && settings?.providerMode === 'managed'
      ? managedPlayerAuth
      : result && settings && hasLlmAuth(settings)
      ? (() => {
          try {
            return resolveLlmAuth(settings);
          } catch {
            return null;
          }
        })()
      : null;
  const hasPlayer = Boolean(result && playerAuth);

  useEffect(() => {
    const pageUrl = location.href;

    const resetLocalBrief = () => {
      moneySessionRef.current = null;
      managedRuntimeSessionRef.current = null;
      setManagedPlayerAuth(null);
      setResult(null);
      setPhase('idle');
      setError('');
      setExtracting(false);
      setNarrating(false);
    };

    void (async () => {
      const loaded = await getSettings();
      setSettings(loaded);

      const state = (await browser.runtime.sendMessage({
        type: 'GET_BRIEF_STATE',
      })) as BriefStateResponse;
      const matched =
        state.result && samePageUrl(state.result.source.url, pageUrl)
          ? state.result
          : null;
      if (matched) {
        moneySessionRef.current = matched.moneySessionId ?? null;
        setPhase(state.progress.phase);
        setExtracting(Boolean(state.running));
        setResult(matched);
        if (state.progress.phase === 'generating_audio') {
          setNarrating(true);
          setStreamKey((k) => k + 1);
        }
      } else if (state.running) {
        setResult(null);
        setPhase(state.progress.phase);
        setExtracting(true);
      } else {
        setResult(null);
        setPhase('idle');
        setExtracting(false);
      }
    })();

    const onMessage = (message: ExtensionMessage) => {
      if (message.type === 'BRIEF_RESET') {
        resetLocalBrief();
        return;
      }
      if (message.type === 'BRIEF_PROGRESS') {
        if (
          message.progress.phase === 'generating_audio' &&
          hasScriptRef.current
        ) {
          return;
        }
        setPhase(message.progress.phase);
        setError('');
        if (
          message.progress.phase === 'extracting' ||
          message.progress.phase === 'understanding' ||
          message.progress.phase === 'writing'
        ) {
          setExtracting(true);
        } else {
          setExtracting(false);
        }
      }
      if (message.type === 'BRIEF_SCRIPT_READY') {
        if (!samePageUrl(message.result.source.url, location.href)) {
          return;
        }
        moneySessionRef.current = message.result.moneySessionId ?? null;
        managedRuntimeSessionRef.current = null;
        setManagedPlayerAuth(null);
        setResult(message.result);
        setPhase('generating_audio');
        setExtracting(false);
        setNarrating(true);
        setError('');
        setStreamKey((k) => k + 1);
      }
      if (message.type === 'BRIEF_ERROR') {
        setPhase('error');
        setError(message.error);
        setExtracting(false);
        setNarrating(false);
      }
    };

    const onStorageChanged: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area !== 'local') return;
      if (!changes.autovoxSettings) return;
      void getSettings().then((loaded) => {
        setSettings(loaded);
        if (hasLlmAuth(loaded)) {
          setError((prev) => {
            const lower = prev.toLowerCase();
            if (
              lower.includes('api key') ||
              lower.includes('connect') ||
              lower.includes('provider')
            ) {
              return '';
            }
            return prev;
          });
          setPhase((prev) => (prev === 'error' ? 'idle' : prev));
        }
      });
    };

    browser.runtime.onMessage.addListener(onMessage);
    browser.storage.onChanged.addListener(onStorageChanged);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      browser.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const openOptions = () => {
    void browser.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  };

  const startBrief = async () => {
    const latest = await getSettings();
    setSettings(latest);
    if (!hasLlmAuth(latest)) {
      setError('Connect with OpenRouter or add an OpenAI API key in Options first.');
      setPhase('error');
      return;
    }

    setError('');
    moneySessionRef.current = null;
    managedRuntimeSessionRef.current = null;
    setManagedPlayerAuth(null);
    setResult(null);
    setNarrating(false);
    setExtracting(true);
    setPhase('extracting');

    const response = (await browser.runtime.sendMessage({
      type: 'START_BRIEF',
    })) as { ok: boolean; error?: string };

    if (!response?.ok) {
      setExtracting(false);
      setPhase('error');
      setError(response?.error ?? 'Could not start briefing');
    }
  };

  const clearBrief = async () => {
    await browser.runtime.sendMessage({ type: 'CLEAR_BRIEF' });
    moneySessionRef.current = null;
    managedRuntimeSessionRef.current = null;
    setManagedPlayerAuth(null);
    setResult(null);
    setPhase('idle');
    setError('');
    setExtracting(false);
    setNarrating(false);
  };

  const handlePlaying = useCallback(() => {
    setPhase('ready');
    setNarrating(true);
    void reportManagedPlayback({ type: 'playback_started' });
  }, [reportManagedPlayback]);

  const handleDone = useCallback((playbackSeconds: number) => {
    setPhase('ready');
    setNarrating(false);
    void finishTtsSession('completed');
    void reportManagedPlayback({ type: 'completed', playbackSeconds });
  }, [finishTtsSession, reportManagedPlayback]);

  const handleError = useCallback((message: string, playbackSeconds: number) => {
    setPhase('error');
    setNarrating(false);
    setError(message);
    void finishTtsSession('fault', 'tts');
    void reportManagedPlayback({
      type: 'fault',
      stage: 'tts',
      playbackSeconds,
    });
  }, [finishTtsSession, reportManagedPlayback]);

  const handleAbort = useCallback((playbackSeconds: number) => {
    void finishTtsSession('aborted');
    void reportManagedPlayback({ type: 'aborted', playbackSeconds });
  }, [finishTtsSession, reportManagedPlayback]);

  const handleUsage = useCallback(
    (usage: ProviderUsage) => attachTtsUsage(usage),
    [attachTtsUsage],
  );

  const label =
    hasAuth === false ? 'No auth' : meterLabel(phase, error, extracting);

  return (
    <div className="autovox-card">
      <div className="autovox-card__face">
        <header className="autovox-card__header">
          <h1 className="autovox-card__title">Autovox</h1>
          <button
            type="button"
            className="autovox-btn autovox-btn--ghost autovox-btn--close"
            onClick={onClose}
            aria-label="Close Autovox"
          >
            Close
          </button>
        </header>

        {hasPlayer ? (
          <>
            <StreamingPlayer
              key={`${streamKey}:${settings!.providerMode}`}
              script={result!.script}
              auth={playerAuth!}
              voice={settings!.voice}
              outputLanguage={settings!.outputLanguage}
              autoPlay
              onPlaying={handlePlaying}
              onDone={handleDone}
              onError={handleError}
              onAbort={handleAbort}
              onUsage={handleUsage}
            />
            <p className="autovox-source">
              {result!.source.siteName ? `${result!.source.siteName} · ` : ''}
              {result!.source.title}
            </p>
            <ScriptPreview script={result!.script} />
            <p className="autovox-notice">Synthetic voice · not human</p>
          </>
        ) : (
          <div className="player">
            <div className="player__bar">
              <button
                type="button"
                className="player__icon-btn player__icon-btn--armed"
                disabled={busy || hasAuth === false}
                onClick={() => void startBrief()}
                aria-label="Brief this page"
              >
                <PlayIcon />
              </button>
              <div
                className={`player__scrub${extracting ? ' player__scrub--loading' : ''}`}
                role="progressbar"
                aria-label="Brief progress"
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={extracting ? 0.4 : 0}
              >
                <div className="player__scrub-rail">
                  <div
                    className="player__scrub-buffered"
                    style={{ width: extracting ? '40%' : '0%' }}
                  />
                  <div
                    className="player__scrub-fill"
                    style={{ width: extracting ? '40%' : '0%' }}
                  />
                </div>
              </div>
              <span
                className={`player__label${error || hasAuth === false ? ' player__label--error' : ''}${!label ? ' player__label--empty' : ''}`}
                title={error || undefined}
              >
                {label || '\u00a0'}
              </span>
            </div>
          </div>
        )}

        <div className="autovox-actions__meta">
          <button
            type="button"
            className="autovox-link"
            disabled={extracting}
            onClick={openOptions}
          >
            Options
          </button>
          {result ? (
            <>
              <span className="autovox-actions__sep" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className="autovox-link"
                disabled={extracting}
                onClick={() => void clearBrief()}
              >
                Clear
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
