import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BriefMeter } from './BriefMeter';
import { Chalkboard } from './Chalkboard';
import { ScriptPreview } from './ScriptPreview';
import { StreamingPlayer } from './StreamingPlayer';
import { samePageUrl } from '../utils/briefState';
import { hasLlmAuth, resolveLlmAuth, type LlmAuth } from '../utils/auth';
import {
  errorMeterLabel,
  type BriefErrorKind,
  type ErrorResponse,
} from '../utils/errors';
import {
  addMoneyLine,
  finishMoneySession,
  getMoneyEvent,
  startMoneySession,
  usageToLineItem,
} from '../utils/money';
import { getSettings } from '../utils/storage';
import { activeModels } from '../utils/models';
import { buildTeacherInstructions, lessonTtsChunks } from '../utils/tts';
import { downloadVideo, renderChalkVideo } from '../utils/chalk/video';
import type {
  ChalkSceneDrawing,
  ChalkTimeline,
  SessionFormat,
} from '../utils/chalk/types';
import type { ProviderUsage } from '../utils/usage';
import type {
  BriefDraft,
  BriefPhase,
  BriefProgress,
  BriefResult,
  ExtensionMessage,
  ReportLength,
  Settings,
} from '../utils/types';

interface BriefStateResponse {
  progress: BriefProgress;
  result: BriefResult | null;
  running: boolean;
}

type ManagedAuthResponse =
  | { ok: true; sessionId: string; auth: LlmAuth }
  | ErrorResponse;

interface OverlayAppProps {
  onClose: () => void;
  /** Called once BRIEF_* messages reach the overlay. */
  onReady?: () => void;
}

const EMPTY_TIMELINE: ChalkTimeline = { starts: [], ends: [] };

type SceneBacklog = {
  sessionId: string;
  scenes: Map<number, ChalkSceneDrawing>;
};

/** Fold scenes that arrived before (or alongside) the result into it. */
function withScenes(
  result: BriefResult,
  backlog: SceneBacklog | null,
): BriefResult {
  const lesson = result.lesson;
  if (!lesson || !backlog || backlog.sessionId !== result.moneySessionId) {
    return result;
  }
  const drawings = lesson.scenes.map(
    (_, index) => backlog.scenes.get(index) ?? result.drawings?.[index] ?? null,
  );
  return { ...result, drawings };
}

type BriefFault = { message: string; kind: BriefErrorKind };

/** Short meter labels only — no idle instructional copy, no long headlines. */
function meterLabel(
  phase: BriefPhase,
  fault: BriefFault | null,
  extracting: boolean,
): string {
  if (fault) return errorMeterLabel(fault.kind);
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

export function OverlayApp({ onClose, onReady }: OverlayAppProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<BriefPhase>('idle');
  const [extracting, setExtracting] = useState(false);
  const [sourceWords, setSourceWords] = useState<number | null>(null);
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [result, setResult] = useState<BriefResult | null>(null);
  const [fault, setFault] = useState<BriefFault | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  const [narrating, setNarrating] = useState(false);
  const [managedPlayerAuth, setManagedPlayerAuth] =
    useState<LlmAuth | null>(null);
  const [timeline, setTimeline] = useState<ChalkTimeline>(EMPTY_TIMELINE);
  const clockRef = useRef<(() => number) | null>(null);
  const [narrationPcm, setNarrationPcm] = useState<Uint8Array | null>(null);
  const [exportPercent, setExportPercent] = useState<number | null>(null);
  const [exportError, setExportError] = useState('');
  const exportAbortRef = useRef<AbortController | null>(null);
  const sceneBacklogRef = useRef<SceneBacklog | null>(null);
  const getBoardTime = useCallback(() => clockRef.current?.() ?? 0, []);

  const hasScriptRef = useRef(false);
  hasScriptRef.current = Boolean(result);
  const moneySessionRef = useRef<string | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const faultRef = useRef<BriefFault | null>(null);
  const managedRuntimeSessionRef = useRef<string | null>(null);
  settingsRef.current = settings;
  faultRef.current = fault;

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
      })) as ManagedAuthResponse | undefined;
      if (cancelled) return;
      if (!response?.ok) {
        setManagedPlayerAuth(null);
        setFault(
          response
            ? { message: response.error, kind: response.kind }
            : { message: 'Managed listening is unavailable', kind: 'fault' },
        );
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

  const attachTtsUsage = useCallback(async (
    usage: ProviderUsage,
    originalReportLength: ReportLength | undefined,
  ) => {
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
        reportLength: originalReportLength ?? latest.reportLength,
        voice: latest.voice,
        outputLanguage: latest.outputLanguage,
        authMode,
      });
      moneySessionRef.current = sessionId;
    }
    if (!sessionId) return;

    await addMoneyLine(
      sessionId,
      usageToLineItem('tts', activeModels(latest).tts, usage),
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
      let response: { ok?: boolean };
      try {
        response = (await browser.runtime.sendMessage({
          type: 'MANAGED_LIFECYCLE',
          sessionId,
          event,
        })) as { ok?: boolean };
      } catch {
        return;
      }
      if (
        response?.ok &&
        terminal &&
        managedRuntimeSessionRef.current === sessionId
      ) {
        managedRuntimeSessionRef.current = null;
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
  const lesson = result?.format === 'chalkboard' ? result.lesson : undefined;
  const lessonChunks = useMemo(
    () => (lesson ? lessonTtsChunks(lesson) : undefined),
    [lesson],
  );
  const teacherInstructions =
    lesson && settings
      ? buildTeacherInstructions(result?.outputLanguage ?? settings.outputLanguage)
      : undefined;

  const handleNarration = useCallback((pcm: Uint8Array | null) => {
    exportAbortRef.current?.abort();
    setExportError('');
    setNarrationPcm(pcm);
  }, []);

  useEffect(() => () => exportAbortRef.current?.abort(), []);

  const exportVideo = async () => {
    if (exportAbortRef.current) {
      exportAbortRef.current.abort();
      return;
    }
    if (!lesson || !narrationPcm) return;
    const abort = new AbortController();
    exportAbortRef.current = abort;
    setExportError('');
    setExportPercent(0);
    try {
      const video = await renderChalkVideo({
        lesson,
        drawings: result?.drawings ?? lesson.scenes.map(() => null),
        timeline,
        pcm: narrationPcm,
        signal: abort.signal,
        onProgress: (fraction) => setExportPercent(Math.floor(fraction * 100)),
      });
      downloadVideo(video);
    } catch (err) {
      if (!abort.signal.aborted) {
        console.warn('[autovox] video export failed', err);
        setExportError(err instanceof Error ? err.message : 'Video export failed');
      }
    } finally {
      if (exportAbortRef.current === abort) {
        exportAbortRef.current = null;
        setExportPercent(null);
      }
    }
  };

  useEffect(() => {
    const pageUrl = location.href;

    const resetLocalBrief = () => {
      moneySessionRef.current = null;
      managedRuntimeSessionRef.current = null;
      setManagedPlayerAuth(null);
      setTimeline(EMPTY_TIMELINE);
      setResult(null);
      setPhase('idle');
      setFault(null);
      setExtracting(false);
      setSourceWords(null);
      setDraft(null);
      setNarrating(false);
    };

    const loadBriefState = async () => {
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
        setResult(withScenes(matched, sceneBacklogRef.current));
        if (state.progress.phase === 'generating_audio') {
          setNarrating(true);
          setStreamKey((k) => k + 1);
        }
      } else if (state.running) {
        setResult(null);
        setPhase(state.progress.phase);
        setSourceWords(state.progress.sourceWords ?? null);
        setExtracting(true);
      } else {
        setResult(null);
        setPhase('idle');
        setExtracting(false);
      }
    };

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
        setFault(null);
        setSourceWords(message.progress.sourceWords ?? null);
        if (message.progress.phase === 'extracting') setDraft(null);
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
      if (message.type === 'BRIEF_DRAFT') {
        if (hasScriptRef.current || !samePageUrl(message.pageUrl, location.href)) {
          return;
        }
        setDraft(message.draft);
      }
      if (message.type === 'BRIEF_SCRIPT_READY') {
        if (!samePageUrl(message.result.source.url, location.href)) {
          return;
        }
        setDraft(null);
        setSourceWords(null);
        moneySessionRef.current = message.result.moneySessionId ?? null;
        managedRuntimeSessionRef.current = null;
        setManagedPlayerAuth(null);
        setTimeline(EMPTY_TIMELINE);
        setResult(withScenes(message.result, sceneBacklogRef.current));
        setPhase('generating_audio');
        setExtracting(false);
        setNarrating(true);
        setFault(null);
        setStreamKey((k) => k + 1);
      }
      if (message.type === 'CHALK_SCENE_READY') {
        if (!samePageUrl(message.pageUrl, location.href)) return;
        let backlog = sceneBacklogRef.current;
        if (backlog?.sessionId !== message.sessionId) {
          backlog = { sessionId: message.sessionId, scenes: new Map() };
          sceneBacklogRef.current = backlog;
        }
        backlog.scenes.set(message.scene, message.drawing);
        setResult((prev) => (prev ? withScenes(prev, backlog) : prev));
      }
      if (message.type === 'BRIEF_ERROR') {
        setPhase('error');
        setFault({ message: message.error, kind: message.kind });
        setExtracting(false);
        setDraft(null);
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
        if (hasLlmAuth(loaded) && faultRef.current?.kind === 'setup') {
          setFault(null);
          setPhase((prev) => (prev === 'error' ? 'idle' : prev));
        }
      });
    };

    browser.runtime.onMessage.addListener(onMessage);
    browser.storage.onChanged.addListener(onStorageChanged);
    // After the initial load, so its stale state can't overwrite the first BRIEF_PROGRESS.
    void loadBriefState().finally(() => onReady?.());
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      browser.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const openOptions = () => {
    void browser.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  };

  const startBrief = async (format: SessionFormat = 'brief') => {
    const latest = await getSettings();
    setSettings(latest);
    if (!hasLlmAuth(latest)) {
      setFault({
        message: 'Connect with OpenRouter or add an OpenAI API key in Options first.',
        kind: 'setup',
      });
      setPhase('error');
      return;
    }

    setFault(null);
    moneySessionRef.current = null;
    managedRuntimeSessionRef.current = null;
    setManagedPlayerAuth(null);
    setTimeline(EMPTY_TIMELINE);
    handleNarration(null);
    setResult(null);
    setNarrating(false);
    setSourceWords(null);
    setDraft(null);
    setExtracting(true);
    setPhase('extracting');

    const response = (await browser.runtime.sendMessage({
      type: 'START_BRIEF',
      format,
    })) as { ok: true } | ErrorResponse | undefined;

    if (!response?.ok) {
      setExtracting(false);
      setPhase('error');
      setFault(
        response
          ? { message: response.error, kind: response.kind }
          : { message: 'Could not start briefing', kind: 'fault' },
      );
    }
  };

  const clearBrief = async () => {
    await browser.runtime.sendMessage({ type: 'CLEAR_BRIEF' });
    moneySessionRef.current = null;
    managedRuntimeSessionRef.current = null;
    setManagedPlayerAuth(null);
    setTimeline(EMPTY_TIMELINE);
    handleNarration(null);
    setResult(null);
    setPhase('idle');
    setFault(null);
    setExtracting(false);
    setSourceWords(null);
    setDraft(null);
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

  const handleError = useCallback((
    message: string,
    playbackSeconds: number,
    kind: BriefErrorKind,
  ) => {
    setPhase('error');
    setNarrating(false);
    setFault({ message, kind });
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
    (usage: ProviderUsage) =>
      attachTtsUsage(usage, result?.reportLength),
    [attachTtsUsage, result?.reportLength],
  );

  const label =
    hasAuth === false ? 'Needs setup' : meterLabel(phase, fault, extracting);

  return (
    <div className={`autovox-card${lesson ? ' autovox-card--board' : ''}`}>
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

        {lesson ? (
          <Chalkboard
            lesson={lesson}
            drawings={result!.drawings ?? lesson.scenes.map(() => null)}
            timeline={timeline}
            getTime={getBoardTime}
          />
        ) : null}

        {hasPlayer ? (
          <>
            <StreamingPlayer
              key={`${streamKey}:${settings!.providerMode}`}
              script={result!.script}
              chunks={lessonChunks}
              ttsInstructions={teacherInstructions}
              prefetch={lesson ? 2 : 0}
              onChunkTimeline={lesson ? setTimeline : undefined}
              clockRef={lesson ? clockRef : undefined}
              onNarration={lesson ? handleNarration : undefined}
              auth={playerAuth!}
              model={activeModels(settings!).tts}
              voice={settings!.voice}
              outputLanguage={result!.outputLanguage ?? settings!.outputLanguage}
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
          </>
        ) : (
          <BriefMeter
            working={extracting}
            label={label}
            error={fault?.message ?? ''}
            labelIsError={Boolean(fault) || hasAuth === false}
            playDisabled={busy || hasAuth === false}
            playLabel={
              result?.format === 'chalkboard'
                ? 'Chalkboard this page'
                : 'Brief this page'
            }
            onPlay={() => void startBrief(result?.format ?? 'brief')}
            sourceWords={sourceWords}
            draft={draft}
          />
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
          {!lesson ? (
            <>
              <span className="autovox-actions__sep" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className="autovox-link"
                disabled={busy || hasAuth === false}
                onClick={() => void startBrief('chalkboard')}
              >
                Chalkboard
              </button>
            </>
          ) : null}
          {lesson && narrationPcm ? (
            <>
              <span className="autovox-actions__sep" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className={`autovox-link${exportError && exportPercent === null ? ' autovox-link--error' : ''}`}
                disabled={extracting}
                onClick={() => void exportVideo()}
                title={
                  exportPercent !== null
                    ? 'Cancel export'
                    : exportError ||
                      (lesson.scenes.some((_, i) => !result?.drawings?.[i]?.elements.length)
                        ? 'Save as a video. Boards that aren’t drawn yet appear as notes.'
                        : 'Save the chalkboard and narration as a video')
                }
              >
                {exportPercent !== null
                  ? `Exporting ${exportPercent}%`
                  : exportError
                    ? 'Export failed'
                    : 'Export video'}
              </button>
            </>
          ) : null}
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
