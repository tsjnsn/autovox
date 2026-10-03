import { useId, useRef, useState } from 'react';
import {
  ARTICLE_TYPE_CHOICES,
  ARTICLE_TYPE_SPECS,
  articleTypeLabel,
  choiceChangesType,
  rebriefCreditsLabel,
  type ArticleTypeChoice,
  type ResolvedArticleType,
} from '../utils/comprehension';
import type { ReportLength } from '../utils/types';

interface ArticleTypePickerProps {
  choice: ArticleTypeChoice;
  /** The brief on screen, once there is one. */
  current: ResolvedArticleType | null;
  onChoose: (choice: ArticleTypeChoice) => void;
  /** Starts a new brief on this page with `choice`. */
  onRebrief: () => void;
  chalkboard: boolean;
  /** Credits are charged by length; null when the listener uses their own provider. */
  managedLength: ReportLength | null;
  disabled: boolean;
}

function describe(
  choice: ArticleTypeChoice,
  current: ResolvedArticleType | null,
): string {
  if (choice !== 'infer') {
    return `Article type: ${ARTICLE_TYPE_SPECS[choice].label}`;
  }
  if (!current || current.source === 'chosen') {
    return 'Article type: Infer, picked for each article';
  }
  const label = ARTICLE_TYPE_SPECS[current.type].label;
  return current.source === 'inferred'
    ? `Article type: Infer. This one read as ${label}.`
    : `Article type: Infer. The writer didn't say, so this one is filed as ${label}.`;
}

/**
 * Quiet meta control for the article type. It never starts a brief by itself:
 * with a brief on screen, a different pick offers an explicit re-brief that
 * names its cost, since a new brief spends a credit in managed mode.
 */
export function ArticleTypePicker({
  choice,
  current,
  onChoose,
  onRebrief,
  chalkboard,
  managedLength,
  disabled,
}: ArticleTypePickerProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inferred =
    choice === 'infer' && current && current.source !== 'chosen'
      ? ARTICLE_TYPE_SPECS[current.type].short
      : null;
  const offerRebrief = choiceChangesType(choice, current);

  if (disabled && open) setOpen(false);

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  const choose = (next: ArticleTypeChoice) => {
    onChoose(next);
    if (!choiceChangesType(next, current)) setOpen(false);
  };

  const cost = managedLength
    ? rebriefCreditsLabel(chalkboard ? 'chalkboard' : 'brief', managedLength)
    : null;
  const rebriefText = `${chalkboard ? 'Redraw' : 'Re-brief'} ${
    choice === 'infer' ? 'with Infer' : `as ${ARTICLE_TYPE_SPECS[choice].short}`
  }${cost ? ` · ${cost}` : ''}`;

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="autovox-link type-picker__toggle"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={describe(choice, current)}
        title={describe(choice, current)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <span>
          {inferred ? (
            <>
              <span className="type-picker__mode">Infer ·</span> {inferred}
            </>
          ) : (
            articleTypeLabel(choice, current)
          )}
        </span>
        <span className="type-picker__caret" aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={panelId}
          className="type-picker"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          <span className="type-picker__legend" id={`${panelId}-legend`}>
            Article type
          </span>
          <div
            className="type-picker__choices"
            role="radiogroup"
            aria-labelledby={`${panelId}-legend`}
          >
            {ARTICLE_TYPE_CHOICES.map((id) => {
              const isCurrent = id !== 'infer' && current?.type === id;
              const hint =
                id === 'infer'
                  ? 'Autovox picks the type for each article'
                  : `${ARTICLE_TYPE_SPECS[id].label}. The page ${ARTICLE_TYPE_SPECS[id].cue}.`;
              return (
                <label
                  key={id}
                  className="type-picker__choice"
                  title={isCurrent ? `${hint} · this brief` : hint}
                >
                  <input
                    type="radio"
                    name={panelId}
                    value={id}
                    checked={choice === id}
                    onChange={() => choose(id)}
                  />
                  <span
                    className={`type-picker__face${isCurrent ? ' type-picker__face--current' : ''}`}
                  >
                    {id === 'infer' ? 'Infer' : ARTICLE_TYPE_SPECS[id].short}
                  </span>
                </label>
              );
            })}
          </div>
          {offerRebrief ? (
            <button
              type="button"
              className="autovox-link type-picker__rebrief"
              disabled={disabled}
              title={
                cost
                  ? `Briefs this page again. Uses ${cost}, like any brief.`
                  : 'Briefs this page again with your provider.'
              }
              onClick={() => {
                setOpen(false);
                onRebrief();
              }}
            >
              {rebriefText}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
