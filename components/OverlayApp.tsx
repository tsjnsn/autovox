import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FollowUpAsk } from './FollowUpAsk';
import { PlayMenu, playChoiceLabel, type PlayChoice } from './PlayMenu';
import { ReelSkip, SavedBoard, SavedNotes } from './SavedTape';
import { BriefMeter } from './BriefMeter';
import { Chalkboard } from './Chalkboard';
import { ScriptPreview } from './ScriptPreview';
import { StreamingPlayer, type PlayMenuControl } from './StreamingPlayer';
import { samePageUrl } from '../utils/pageUrl';
import {
  errorMeterLabel,
  type BriefErrorKind,
  type ErrorResponse,
} from '../utils/errors';
import { lessonTtsChunks } from '../utils/tts';
import {
  choiceChangesType,
  effectiveArticleTypeChoice,
  rebriefCreditsLabel,
  type ArticleTypeChoice,
} from '../utils/comprehension';
import { downloadVideo, renderChalkVideo } from '../utils/chalk/video';
import type {
  ChalkSceneDrawing,
  ChalkTimeline,
  SessionFormat,
} from '../utils/chalk/types';
import {
  readArtifactSummaries,
  readSavedTape,
  type ArtifactSummary,
  type SavedTape,
} from '../utils/artifactView';
import { readOverlaySettings } from '../utils/overlayView';
import type {
  BriefDraft,
  BriefPhase,
  BriefProgress,
  BriefResult,
  ExtensionMessage,
  OverlaySettings,
} from '../utils/types';

interface BriefStateResponse {
  progress: BriefProgress;
  result: BriefResult | null;
  running: boolean;
}

/** A null session means the narration is saved and spends nothing. */
type ManagedNarrationResponse =
  | { ok: true; sessionId: string | null }
  | ErrorResponse;

type ManagedNarration = { sessionId: string | null };

async function getOverlaySettings(): Promise<OverlaySettings | null> {
  try {
    return readOverlaySettings(
      await browser.runtime.sendMessage({
        type: 'GET_OVERLAY_SETTINGS',
      }),
    );
  } catch {
    return null;
  }
}

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
  const [settings, setSettings] = useState<OverlaySettings | null>(null);
  const [phase, setPhase] = useState<BriefPhase>('idle');
  const [extracting, setExtracting] = useState(false);
  const [sourceWords, setSourceWords] = useState<number | null>(null);
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [result, setResult] = useState<BriefResult | null>(null);
  const [articleTypeOverride, setArticleTypeOverride] =
    useState<ArticleTypeChoice | null>(null);
  const [fault, setFault] = useState<BriefFault | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  const [narrating, setNarrating] = useState(false);
  const [managedNarration, setManagedNarration] =
    useState<ManagedNarration | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const [timeline, setTimeline] = useState<ChalkTimeline>(EMPTY_TIMELINE);
  const clockRef = useRef<(() => number) | null>(null);
  const [narrationPcm, setNarrationPcm] = useState<Uint8Array | null>(null);
  const [exportPercent, setExportPercent] = useState<number | null>(null);
  const [exportError, setExportError] = useState('');
  const [saved, setSaved] = useState<ArtifactSummary[]>([]);
  const [tapeId, setTapeId] = useState<string | null>(null);
  const [tape, setTape] = useState<SavedTape | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const [playMenuOpen, setPlayMenuOpen] = useState(false);
  const playMenuId = useId();
  /** False while a saved listen waits to be chosen from the play menu. */
  const [armPlayback, setArmPlayback] = useState(false);
  const playRef = useRef<(() => void) | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const sceneBacklogRef = useRef<SceneBacklog | null>(null);
  const getBoardTime = useCallback(() => clockRef.current?.() ?? 0, []);

  const hasScriptRef = useRef(false);
  const moneySessionRef = useRef<string | null>(null);
  const faultRef = useRef<BriefFault | null>(null);
  const managedRuntimeSessionRef = useRef<string | null>(null);
  const managedNarrationRef = useRef<ManagedNarration | null>(null);
  useLayoutEffect(() => {
    hasScriptRef.current = Boolean(result);
    faultRef.current = fault;
    managedNarrationRef.current = managedNarration;
  });

  useEffect(() => {
    moneySessionRef.current = result?.moneySessionId ?? null;
  }, [result?.moneySessionId]);

  /** Every result change already clears managed narration; settings changes go through here. */
  const applySettings = useCallback((next: OverlaySettings) => {
    setSettings(next);
    if (next.providerMode !== 'managed') {
      managedRuntimeSessionRef.current = null;
      setManagedNarration(null);
    }
  }, []);

  useEffect(() => {
    if (
      !result?.managedSessionId ||
      settings?.providerMode !== 'managed'
    ) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const response = (await browser.runtime.sendMessage({
        type: 'PREPARE_MANAGED_NARRATION',
        sessionId: result.managedSessionId,
        estimatedSeconds: result.script.estimatedSeconds,
        reportLength:
          result.reportLength ?? settings.reportLength,
        voice: settings.voice,
        outputLanguage: settings.outputLanguage,
      })) as ManagedNarrationResponse | undefined;
      if (cancelled) return;
      if (!response?.ok) {
        setManagedNarration(null);
        setFault(
          response
            ? { message: response.error, kind: response.kind }
            : { message: 'Managed listening is unavailable', kind: 'fault' },
        );
        setPhase('error');
        setNarrating(false);
        return;
      }
      // Narration on an ended session restarts once it has a replacement.
      const known = managedNarrationRef.current?.sessionId ?? null;
      managedRuntimeSessionRef.current = response.sessionId;
      setManagedNarration({ sessionId: response.sessionId });
      if (known !== null && known !== response.sessionId) {
        setAuthRevision((revision) => revision + 1);
      }
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

  const handleManagedSession = useCallback((sessionId: string) => {
    managedRuntimeSessionRef.current = sessionId;
    setManagedNarration({ sessionId });
  }, []);

  const finishTtsSession = useCallback(
    async (
      outcome: 'completed' | 'fault' | 'aborted',
      faultStage: 'tts' | 'none' = 'none',
    ) => {
      const sessionId = moneySessionRef.current;
      if (!sessionId) return;
      await browser.runtime.sendMessage({
        type: 'FINISH_NARRATION_SPEND',
        sessionId,
        outcome,
        faultStage,
      } satisfies ExtensionMessage);
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

  const liveId = result?.moneySessionId ?? null;
  const showingLive =
    Boolean(result) && (tapeId === null || tapeId === liveId);
  const viewedId = showingLive ? liveId : (tapeId ?? saved[0]?.id ?? null);
  const onFace = !showingLive && tape && tape.id === viewedId ? tape : null;

  useEffect(() => {
    let cancelled = false;
    void browser.runtime.sendMessage({ type: 'LIST_ARTIFACTS' }).then(
      (response: unknown) => {
        if (!cancelled) setSaved(readArtifactSummaries(response));
      },
      () => {
        if (!cancelled) setSaved([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [savedTick]);

  useEffect(() => {
    if (!viewedId || showingLive) return;
    let cancelled = false;
    void browser.runtime.sendMessage({ type: 'GET_ARTIFACT', id: viewedId }).then(
      (response: unknown) => {
        if (cancelled) return;
        const next = readSavedTape(response);
        setTape(next && next.id === viewedId ? next : null);
      },
      () => {
        if (!cancelled) setTape(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [viewedId, showingLive, savedTick]);

  const selectTape = (id: string) => {
    setTapeId(id === liveId ? null : id);
  };

  const removeTape = () => {
    if (!onFace) return;
    void browser.runtime.sendMessage({
      type: 'REMOVE_ARTIFACT',
      id: onFace.id,
    }).then(() => {
      setTapeId(null);
      setTape(null);
      setSavedTick((tick) => tick + 1);
    });
  };

  const hasAuth = settings ? settings.hasAuth : null;
  const busy = extracting || narrating;
  const playBlocked = busy || hasAuth === false;
  if (playBlocked && playMenuOpen) setPlayMenuOpen(false);
  const hasPlayer = Boolean(
    result &&
      settings &&
      (settings.providerMode === 'managed' ? managedNarration : settings.hasAuth),
  );
  const lesson = result?.format === 'chalkboard' ? result.lesson : undefined;
  const lessonChunks = useMemo(
    () => (lesson ? lessonTtsChunks(lesson) : undefined),
    [lesson],
  );
  const articleTypeChoice = effectiveArticleTypeChoice(
    articleTypeOverride,
    result?.articleType ?? null,
    settings?.articleType,
  );

  /** This page's listen, when play can start it again without spending. */
  const replayFormat: SessionFormat | null =
    hasPlayer && showingLive && result ? (result.format ?? 'brief') : null;
  // A type pick that would tell the page differently means a new listen.
  const primaryPlay: PlayChoice =
    replayFormat &&
    !choiceChangesType(articleTypeChoice, result?.articleType ?? null)
      ? 'replay'
      : (replayFormat ?? 'brief');
  const managedLength =
    settings?.providerMode === 'managed' ? settings.reportLength : null;
  const newSessionCosts =
    result && managedLength
      ? {
          brief: rebriefCreditsLabel('brief', managedLength),
          chalkboard: rebriefCreditsLabel('chalkboard', managedLength),
        }
      : null;

  const handleNarration = useCallback((pcm: Uint8Array | null) => {
    exportAbortRef.current?.abort();
    setExportError('');
    setNarrationPcm(pcm);
  }, []);

  useEffect(() => () => exportAbortRef.current?.abort(), []);

  const signalReady = useEffectEvent(() => onReady?.());

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
      setManagedNarration(null);
      setTimeline(EMPTY_TIMELINE);
      setResult(null);
      setPhase('idle');
      setFault(null);
      setExtracting(false);
      setSourceWords(null);
      setDraft(null);
      setNarrating(false);
      setArticleTypeOverride(null);
    };

    const loadBriefState = async () => {
      const loaded = await getOverlaySettings();
      if (loaded) applySettings(loaded);

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
          setArmPlayback(true);
          setStreamKey((k) => k + 1);
        } else {
          setArmPlayback(false);
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
        setManagedNarration(null);
        setTimeline(EMPTY_TIMELINE);
        setResult(withScenes(message.result, sceneBacklogRef.current));
        setPhase('generating_audio');
        setExtracting(false);
        setNarrating(true);
        setArmPlayback(true);
        setFault(null);
        setStreamKey((k) => k + 1);
        setTapeId(null);
        setSavedTick((tick) => tick + 1);
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
        setSavedTick((tick) => tick + 1);
      }
      if (message.type === 'BRIEF_ERROR') {
        setPhase('error');
        setFault({ message: message.error, kind: message.kind });
        setExtracting(false);
        setDraft(null);
        setNarrating(false);
      }
      if (message.type === 'OVERLAY_SETTINGS_CHANGED') {
        const next = readOverlaySettings(message.settings);
        if (!next) return;
        applySettings(next);
        if (message.credentialsChanged) {
          setAuthRevision((revision) => revision + 1);
        }
        if (next.hasAuth && faultRef.current?.kind === 'setup') {
          setFault(null);
          setPhase((prev) => (prev === 'error' ? 'idle' : prev));
        }
      }
    };

    browser.runtime.onMessage.addListener(onMessage);
    // After the initial load, so its stale state can't overwrite the first BRIEF_PROGRESS.
    void loadBriefState().finally(() => signalReady());
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, [applySettings]);

  const openOptions = () => {
    void browser.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  };

  const startBrief = async (format: SessionFormat = 'brief') => {
    const latest = await getOverlaySettings();
    if (latest) applySettings(latest);
    if (!latest?.hasAuth) {
      setFault({
        message: 'Connect with OpenRouter or add an OpenAI API key in Options first.',
        kind: 'setup',
      });
      setPhase('error');
      return;
    }

    setFault(null);
    setTapeId(null);
    setPlayMenuOpen(false);
    moneySessionRef.current = null;
    managedRuntimeSessionRef.current = null;
    setManagedNarration(null);
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
      articleType: effectiveArticleTypeChoice(
        articleTypeOverride,
        result?.articleType ?? null,
        latest.articleType,
      ),
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

  const choosePlay = (choice: PlayChoice) => {
    setPlayMenuOpen(false);
    if (choice !== 'replay') {
      void startBrief(choice);
    } else if (armPlayback) {
      playRef.current?.();
    } else {
      setArmPlayback(true);
    }
  };

  /** The first press opens the menu; a second press starts what it marks. */
  const pressPlay = () => {
    if (playMenuOpen) choosePlay(primaryPlay);
    else setPlayMenuOpen(true);
  };

  const playMenu: PlayMenuControl = {
    id: playMenuId,
    open: playMenuOpen,
    label: playMenuOpen ? playChoiceLabel(primaryPlay) : 'Play',
    onPress: pressPlay,
  };

  const clearBrief = async () => {
    await browser.runtime.sendMessage({ type: 'CLEAR_BRIEF' });
    moneySessionRef.current = null;
    managedRuntimeSessionRef.current = null;
    setManagedNarration(null);
    setTimeline(EMPTY_TIMELINE);
    handleNarration(null);
    setResult(null);
    setPhase('idle');
    setFault(null);
    setExtracting(false);
    setSourceWords(null);
    setDraft(null);
    setNarrating(false);
    setArmPlayback(false);
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

  const label =
    hasAuth === false ? 'Needs setup' : meterLabel(phase, fault, extracting);

  return (
    <div
      className={`autovox-card${(showingLive ? lesson : onFace?.lesson) ? ' autovox-card--board' : ''}`}
    >
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

        {showingLive && lesson ? (
          <Chalkboard
            lesson={lesson}
            drawings={result!.drawings ?? lesson.scenes.map(() => null)}
            timeline={timeline}
            getTime={getBoardTime}
          />
        ) : onFace ? (
          <SavedBoard tape={onFace} />
        ) : null}

        {hasPlayer ? (
          <StreamingPlayer
            held={!showingLive}
            key={`${streamKey}:${settings!.providerMode}`}
            script={result!.script}
            briefId={result!.moneySessionId ?? null}
            authRevision={authRevision}
            managedSessionId={managedNarration?.sessionId ?? null}
            moneySessionRef={moneySessionRef}
            onManagedSession={handleManagedSession}
            chunks={lessonChunks}
            onChunkTimeline={lesson ? setTimeline : undefined}
            clockRef={lesson ? clockRef : undefined}
            onNarration={lesson ? handleNarration : undefined}
            model={settings!.narrationModel}
            voice={settings!.voice}
            outputLanguage={result!.outputLanguage ?? settings!.outputLanguage}
            onPlaying={handlePlaying}
            onDone={handleDone}
            onError={handleError}
            onAbort={handleAbort}
            armed={armPlayback}
            playMenu={showingLive ? playMenu : undefined}
            playRef={playRef}
          />
        ) : null}
        {hasPlayer && showingLive ? null : (
          <BriefMeter
            working={extracting}
            label={label}
            error={fault?.message ?? ''}
            labelIsError={Boolean(fault) || hasAuth === false}
            playDisabled={busy || hasAuth === false}
            playLabel={playMenu.label}
            menuId={playMenuId}
            menuOpen={playMenuOpen}
            onPlay={pressPlay}
            sourceWords={sourceWords}
            draft={draft}
          />
        )}

        {playMenuOpen ? (
          <PlayMenu
            id={playMenuId}
            replayFormat={replayFormat}
            replacing={Boolean(result)}
            primary={primaryPlay}
            costs={newSessionCosts}
            onPick={choosePlay}
            articleType={articleTypeChoice}
            currentType={result?.articleType ?? null}
            onArticleType={setArticleTypeOverride}
            onClose={() => setPlayMenuOpen(false)}
          />
        ) : null}

        {hasPlayer && showingLive ? (
          <>
            <p className="autovox-source">
              {result!.source.siteName ? `${result!.source.siteName} · ` : ''}
              {result!.source.title}
            </p>
            <ScriptPreview script={result!.script} />
          </>
        ) : null}

        {onFace ? <SavedNotes tape={onFace} /> : null}
        <ReelSkip
          summaries={saved}
          selectedId={viewedId}
          headline={showingLive ? (result?.script.headline ?? '') : (onFace?.headline ?? '')}
          disabled={extracting}
          onSelect={selectTape}
        />

        <div className="autovox-actions__meta">
          <button
            type="button"
            className="autovox-link"
            disabled={extracting}
            onClick={openOptions}
          >
            Options
          </button>
          {showingLive && lesson && narrationPcm ? (
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
          {onFace ? (
            <>
              <span className="autovox-actions__sep" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className="autovox-link"
                disabled={extracting}
                onClick={removeTape}
              >
                Remove
              </button>
            </>
          ) : null}
          {result && showingLive ? (
            <>
              <span className="autovox-actions__sep" aria-hidden="true">
                ·
              </span>
              <FollowUpAsk
                script={result.script}
                sourceLabel={
                  result.source.siteName
                    ? `${result.source.siteName} · ${result.source.title}`
                    : result.source.title
                }
                disabled={extracting}
              />
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
          {onFace ? (
            <>
              <span className="autovox-actions__sep" aria-hidden="true">
                ·
              </span>
              <FollowUpAsk
                script={onFace.script}
                sourceLabel={
                  onFace.siteName
                    ? `${onFace.siteName} · ${onFace.sourceTitle}`
                    : onFace.sourceTitle
                }
                disabled={extracting}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
