import { useCallback, useMemo, useState } from 'react';
import { Chalkboard } from './Chalkboard';
import { ScriptPreview } from './ScriptPreview';
import { scenePlayback } from '../utils/artifactPlayback';
import type { ArtifactSummary, SavedTape as SavedTapeData } from '../utils/artifactView';

export function SavedBoard({ tape }: { tape: SavedTapeData }) {
  const [scene, setScene] = useState(0);
  const [tapeId, setTapeId] = useState(tape.id);
  if (tape.id !== tapeId) {
    setTapeId(tape.id);
    setScene(0);
  }
  const playback = useMemo(
    () => (tape.lesson ? scenePlayback(tape.lesson) : null),
    [tape],
  );
  const sceneCount = tape.lesson?.scenes.length ?? 0;
  const sceneIndex = Math.min(scene, Math.max(0, sceneCount - 1));
  const getTime = useCallback(
    () => playback?.sceneTime[sceneIndex] ?? 0,
    [playback, sceneIndex],
  );

  if (!tape.lesson || !playback) return null;

  return (
    <>
      <Chalkboard
        lesson={tape.lesson}
        drawings={tape.drawings ?? tape.lesson.scenes.map(() => null)}
        timeline={playback.timeline}
        getTime={getTime}
      />
      {sceneCount > 1 ? (
        <div className="reel">
          <button
            type="button"
            className="autovox-btn autovox-btn--ghost reel__skip"
            disabled={sceneIndex === 0}
            aria-label="Previous scene"
            onClick={() => setScene(sceneIndex - 1)}
          >
            ‹
          </button>
          <span className="reel__title">
            Scene {sceneIndex + 1} of {sceneCount}
          </span>
          <button
            type="button"
            className="autovox-btn autovox-btn--ghost reel__skip"
            disabled={sceneIndex >= sceneCount - 1}
            aria-label="Next scene"
            onClick={() => setScene(sceneIndex + 1)}
          >
            ›
          </button>
        </div>
      ) : null}
    </>
  );
}

export function SavedNotes({ tape }: { tape: SavedTapeData }) {
  const source = [tape.siteName, tape.sourceTitle].filter(Boolean).join(' · ');
  return (
    <>
      {source ? <p className="autovox-source">{source}</p> : null}
      <ScriptPreview script={tape.script} />
    </>
  );
}

export function ReelSkip({
  summaries,
  selectedId,
  headline,
  onSelect,
  disabled,
}: {
  summaries: ArtifactSummary[];
  selectedId: string | null;
  /** Title when the brief on this page is not in the saved list yet. */
  headline: string;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  if (summaries.length < 2) return null;
  const index = summaries.findIndex((item) => item.id === selectedId);
  const title = index >= 0 ? (summaries[index]?.headline ?? headline) : headline;
  const newer = index > 0 ? summaries[index - 1] : null;
  const older =
    index === -1
      ? summaries[0]
      : index < summaries.length - 1
        ? summaries[index + 1]
        : null;

  return (
    <div className="reel">
      <button
        type="button"
        className="autovox-btn autovox-btn--ghost reel__skip"
        disabled={disabled || !newer}
        aria-label="Newer brief"
        onClick={() => {
          if (newer) onSelect(newer.id);
        }}
      >
        ‹
      </button>
      <span className="reel__title" title={title}>
        {title}
      </span>
      <button
        type="button"
        className="autovox-btn autovox-btn--ghost reel__skip"
        disabled={disabled || !older}
        aria-label="Older brief"
        onClick={() => {
          if (older) onSelect(older.id);
        }}
      >
        ›
      </button>
    </div>
  );
}
