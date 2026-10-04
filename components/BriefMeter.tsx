import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PlayIcon } from './TransportIcons';
import type { BriefDraft } from '../utils/types';

/** A streamed burst types out over about this long, so the tape keeps the model's pace. */
const CATCH_UP_MS = 300;
/** Only the newest text fits on the tape; older text runs off the start edge. */
const TAPE_CHARS = 200;
/** Fill while nothing measurable is happening (extracting, or the model thinking). */
const PILOT_FILL = 0.08;
/** Writing never shows as done; the player takes over once the script exists. */
const MAX_WRITING_FILL = 0.97;

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Prints `text` like a teleprinter. Text that extends what's printed keeps
 * typing from there; anything else starts a fresh line.
 */
function useTeleprinter(text: string): string {
  const [printed, setPrinted] = useState('');
  const printedRef = useRef('');

  useEffect(() => {
    let shown = text.startsWith(printedRef.current) ? printedRef.current.length : 0;
    const show = (count: number) => {
      shown = count;
      printedRef.current = text.slice(0, count);
      setPrinted(printedRef.current);
    };
    if (prefersReducedMotion()) {
      show(text.length);
      return;
    }
    show(shown);
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const backlog = text.length - shown;
      if (backlog <= 0) return;
      const step = Math.max(1, Math.round((backlog * (now - last)) / CATCH_UP_MS));
      last = now;
      show(Math.min(text.length, shown + step));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);

  return text.startsWith(printed) ? printed : '';
}

interface BriefMeterProps {
  /** Extraction or writing is in flight. */
  working: boolean;
  /** Short state for the meter label when no draft is streaming. */
  label: string;
  error: string;
  labelIsError: boolean;
  playDisabled: boolean;
  playLabel: string;
  /** The play menu this button opens. */
  menuId: string;
  menuOpen: boolean;
  onPlay: () => void;
  /** Words in the extracted article; shown while the model reads it. */
  sourceWords: number | null;
  draft: BriefDraft | null;
}

/**
 * The idle transport, and the instrument while a brief is being written: the
 * meter fills with the words written so far and the script prints onto a wire
 * tape beneath it, ending at a blinking cursor.
 */
export function BriefMeter({
  working,
  label,
  error,
  labelIsError,
  playDisabled,
  playLabel,
  menuId,
  menuOpen,
  onPlay,
  sourceWords,
  draft,
}: BriefMeterProps) {
  const writing = working && draft !== null;
  const status =
    working && !draft && sourceWords
      ? `Reading ${sourceWords.toLocaleString()} words`
      : '';
  const tapeText = writing ? draft.text : status;
  const printed = useTeleprinter(tapeText);

  const printedWords =
    writing && draft.text.length > 0
      ? Math.round(draft.words * (printed.length / draft.text.length))
      : 0;
  const fill = writing
    ? Math.min(MAX_WRITING_FILL, Math.max(0.02, printedWords / draft.targetWords))
    : working
      ? PILOT_FILL
      : 0;
  const meterLabel = writing
    ? `${printedWords.toLocaleString()} ${printedWords === 1 ? 'word' : 'words'}`
    : label;
  const tape = printed.length > TAPE_CHARS ? printed.slice(-TAPE_CHARS) : printed;

  const wireRef = useRef<HTMLDivElement>(null);
  const tapeRef = useRef<HTMLSpanElement>(null);
  const [tapeFull, setTapeFull] = useState(false);
  useLayoutEffect(() => {
    const wire = wireRef.current;
    const text = tapeRef.current;
    setTapeFull(Boolean(wire && text && text.offsetWidth > wire.clientWidth + 1));
  }, [tape]);

  return (
    <div className="player">
      <div className="player__bar">
        <button
          type="button"
          className="player__icon-btn player__icon-btn--armed"
          disabled={playDisabled}
          onClick={onPlay}
          aria-label={playLabel}
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
        >
          <PlayIcon />
        </button>
        <div
          className={`player__scrub${working && !tapeText ? ' player__scrub--loading' : ''}`}
          role="progressbar"
          aria-label="Brief progress"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={fill}
          aria-valuetext={
            writing
              ? `${printedWords} of about ${draft.targetWords} words written`
              : status || label || undefined
          }
        >
          <div className="player__scrub-rail">
            <div className="player__scrub-fill" style={{ width: `${fill * 100}%` }} />
          </div>
        </div>
        <span
          className={`player__label${labelIsError ? ' player__label--error' : ''}${!meterLabel ? ' player__label--empty' : ''}`}
          title={error || undefined}
        >
          {meterLabel || '\u00a0'}
        </span>
      </div>
      {working && tapeText ? (
        <div
          ref={wireRef}
          className={`wire${writing ? '' : ' wire--status'}${tapeFull ? ' wire--full' : ''}`}
          dir="auto"
          aria-hidden="true"
        >
          <span ref={tapeRef} className="wire__text">
            {tape}
            <span className="wire__cursor" />
          </span>
        </div>
      ) : null}
    </div>
  );
}
