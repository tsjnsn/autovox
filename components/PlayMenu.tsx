import { useId } from 'react';
import {
  ARTICLE_TYPE_CHOICES,
  ARTICLE_TYPE_SPECS,
  choiceChangesType,
  rebriefCreditsLabel,
  type ArticleTypeChoice,
  type ResolvedArticleType,
} from '../utils/comprehension';
import type { ReportLength } from '../utils/types';
import type { SessionFormat } from '../utils/chalk/types';

interface PlayMenuProps {
  choice: ArticleTypeChoice;
  current: ResolvedArticleType | null;
  onChoose: (choice: ArticleTypeChoice) => void;
  /** A brief is already on screen, so starting again spends like a re-brief. */
  replacing: boolean;
  /** Format already saved. Choosing it again plays that copy, unless the type changed. */
  cachedFormat?: SessionFormat | null;
  managedLength: ReportLength | null;
  onStart: (format: SessionFormat) => void;
  onRegenerate?: () => void;
  onClose: () => void;
}

/**
 * Shown on the first play click. Article type is chosen here; Brief or
 * Chalkboard is what actually starts.
 */
export function PlayMenu({
  choice,
  current,
  onChoose,
  replacing,
  cachedFormat = null,
  managedLength,
  onStart,
  onRegenerate,
  onClose,
}: PlayMenuProps) {
  const legendId = useId();

  const playsCache = (format: SessionFormat) =>
    cachedFormat === format && !choiceChangesType(choice, current);

  const cost = (format: SessionFormat) =>
    !playsCache(format) && replacing && managedLength
      ? rebriefCreditsLabel(format, managedLength)
      : null;

  const regenerateCost =
    onRegenerate && replacing && managedLength
      ? rebriefCreditsLabel(cachedFormat ?? 'brief', managedLength)
      : null;

  return (
    <div
      className="play-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="type-picker__choices">
        {(['brief', 'chalkboard'] as const).map((format) => {
          const price = cost(format);
          const label = format === 'brief' ? 'Brief' : 'Chalkboard';
          const saved = playsCache(format);
          return (
            <button
              key={format}
              type="button"
              className="play-menu__go"
              title={
                saved
                  ? format === 'brief'
                    ? 'Play the saved brief'
                    : 'Play the saved chalkboard'
                  : price
                    ? `Starts again. Uses ${price}, like any brief.`
                    : format === 'brief'
                      ? 'Play a spoken brief of this page'
                      : 'Play this page as a chalkboard'
              }
              onClick={() => onStart(format)}
            >
              {price ? `${label} · ${price}` : label}
            </button>
          );
        })}
        {onRegenerate ? (
          <button
            type="button"
            className="play-menu__go"
            title={
              regenerateCost
                ? `Make this again. Uses ${regenerateCost}, like any brief.`
                : 'Make this page again'
            }
            onClick={onRegenerate}
          >
            {regenerateCost ? `Re-generate · ${regenerateCost}` : 'Re-generate'}
          </button>
        ) : null}
      </div>
      <span className="type-picker__legend" id={legendId}>
        Article type
      </span>
      <div
        className="type-picker__choices"
        role="radiogroup"
        aria-labelledby={legendId}
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
                name={legendId}
                value={id}
                checked={choice === id}
                onChange={() => onChoose(id)}
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
    </div>
  );
}
