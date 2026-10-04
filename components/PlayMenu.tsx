import { useEffect, useEffectEvent, useId, useRef, type KeyboardEvent } from 'react';
import { PlayIcon } from './TransportIcons';
import {
  ARTICLE_TYPE_CHOICES,
  ARTICLE_TYPE_SPECS,
  type ArticleTypeChoice,
  type ResolvedArticleType,
} from '../utils/comprehension';
import type { SessionFormat } from '../utils/chalk/types';

/** What the play menu starts: this page's saved listen again, or a new session. */
export type PlayChoice = 'replay' | SessionFormat;

const FORMAT_LABEL: Record<SessionFormat, string> = {
  brief: 'Brief',
  chalkboard: 'Chalkboard',
};

const FORMAT_HINT: Record<SessionFormat, string> = {
  brief: 'A spoken news report of this page.',
  chalkboard: 'A narrated lesson, drawn on a chalkboard.',
};

/** Name for play while the menu is open: what pressing it again starts. */
export function playChoiceLabel(choice: PlayChoice): string {
  return choice === 'replay' ? 'Play again' : `${FORMAT_LABEL[choice]} this page`;
}

interface PlayMenuProps {
  /** Referenced by play's aria-controls. */
  id: string;
  /** Format of this page's listen when it can play again without spending. */
  replayFormat: SessionFormat | null;
  /** This page already has a listen, so a new one replaces it. */
  replacing: boolean;
  /** What a second press of play starts. */
  primary: PlayChoice;
  /** Credits a new session spends, when that's worth naming. */
  costs: Record<SessionFormat, string> | null;
  onPick: (choice: PlayChoice) => void;
  articleType: ArticleTypeChoice;
  /** The type this page's listen was told as. */
  currentType: ResolvedArticleType | null;
  onArticleType: (choice: ArticleTypeChoice) => void;
  onClose: () => void;
}

interface Item {
  choice: PlayChoice;
  label: string;
  meta: string | null;
  hint: string;
}

/**
 * Drops from play when a press would start something: a new session, or a
 * saved listen that isn't playing. The marked item is what a second press of
 * play starts. Article type only shapes new sessions.
 */
export function PlayMenu({
  id,
  replayFormat,
  replacing,
  primary,
  costs,
  onPick,
  articleType,
  currentType,
  onArticleType,
  onClose,
}: PlayMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const radioName = useId();

  const items: Item[] = [];
  if (replayFormat) {
    items.push({
      choice: 'replay',
      label: 'Play again',
      meta: 'saved',
      hint: `Plays the saved ${FORMAT_LABEL[replayFormat].toLowerCase()}. Nothing is spent.`,
    });
  }
  for (const format of ['brief', 'chalkboard'] as const) {
    const cost = costs?.[format] ?? null;
    items.push({
      choice: format,
      label: replacing
        ? `New ${FORMAT_LABEL[format].toLowerCase()}`
        : FORMAT_LABEL[format],
      meta: cost,
      hint: cost ? `${FORMAT_HINT[format]} Uses ${cost}.` : FORMAT_HINT[format],
    });
  }

  const close = useEffectEvent((returnFocus: boolean) => {
    if (returnFocus) {
      const root = menuRef.current?.getRootNode() as ParentNode | undefined;
      root
        ?.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"]`)
        ?.focus();
    }
    onClose();
  });

  // Open on the marked item, so Enter starts the same thing play would.
  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('.play-menu__item[data-primary]')
      ?.focus();
  }, []);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const root = menu.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : null;
    // Play toggles the menu itself, so a press on it doesn't count as outside.
    const isInside = (path: EventTarget[]) =>
      path.some(
        (node) =>
          node === menu ||
          (node instanceof Element && node.getAttribute('aria-controls') === id),
      );
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.composedPath())) close(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (host && !event.composedPath().includes(host)) return;
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [id]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('.play-menu__item'),
    );
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div
      ref={menuRef}
      id={id}
      className="play-menu"
      role="group"
      aria-label="Play options"
    >
      <div className="play-menu__items" onKeyDown={moveFocus}>
        {items.map((item) => {
          const isPrimary = item.choice === primary;
          return (
            <button
              key={item.choice}
              type="button"
              className="play-menu__item"
              data-primary={isPrimary || undefined}
              title={item.hint}
              onClick={() => onPick(item.choice)}
            >
              <span className="play-menu__cue" aria-hidden="true">
                {isPrimary ? <PlayIcon /> : null}
              </span>
              <span className="play-menu__label">{item.label}</span>
              {item.meta ? (
                <span className="play-menu__meta">{item.meta}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <fieldset className="play-menu__types">
        <legend className="play-menu__legend">Article type</legend>
        <div className="play-menu__bank">
          {ARTICLE_TYPE_CHOICES.map((choice) => {
            const told = choice !== 'infer' && currentType?.type === choice;
            const hint =
              choice === 'infer'
                ? 'Autovox picks the type for each article.'
                : `${ARTICLE_TYPE_SPECS[choice].label}: the page ${ARTICLE_TYPE_SPECS[choice].cue}.`;
            return (
              <label
                key={choice}
                className="play-menu__type"
                title={told ? `${hint} This page's listen was told this way.` : hint}
              >
                <input
                  type="radio"
                  name={radioName}
                  value={choice}
                  checked={articleType === choice}
                  onChange={() => onArticleType(choice)}
                />
                <span
                  className={`play-menu__type-face${told ? ' play-menu__type-face--told' : ''}`}
                >
                  {choice === 'infer' ? 'Infer' : ARTICLE_TYPE_SPECS[choice].short}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
