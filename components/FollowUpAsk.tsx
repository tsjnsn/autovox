import { useEffect, useId, useRef, useState } from 'react';
import {
  copyPlainText,
  followUpClipboard,
  type FollowUpTarget,
} from '../utils/followUp';
import type { NewsReportScript } from '../utils/types';

interface FollowUpAskProps {
  script: NewsReportScript;
  /** Site and title already shown on the player. Never the page URL. */
  sourceLabel: string;
  disabled: boolean;
}

type HandoffStatus = 'idle' | 'opened' | 'copied-only' | 'failed';

const TARGETS: { id: FollowUpTarget; label: string }[] = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
];

/**
 * Quiet handoff. The brief is copied here and the chat app opens with a
 * paste instruction, so the question spends the user's ChatGPT or Claude
 * account rather than an Autovox credit.
 */
export function FollowUpAsk({
  script,
  sourceLabel,
  disabled,
}: FollowUpAskProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<HandoffStatus>('idle');
  const panelId = useId();
  const inputId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (disabled && open) setOpen(false);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setStatus('idle');
    toggleRef.current?.focus();
  };

  const handoff = (target: FollowUpTarget) => {
    const text = followUpClipboard(script, question, sourceLabel);
    const copied = panelRef.current
      ? copyPlainText(panelRef.current, text)
      : false;
    inputRef.current?.focus({ preventScroll: true });
    void (async () => {
      let ok = copied;
      if (!ok) {
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        setStatus('failed');
        return;
      }
      let opened = false;
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'OPEN_FOLLOW_UP',
          target,
        })) as { ok?: boolean } | undefined;
        opened = response?.ok === true;
      } catch {
        opened = false;
      }
      setStatus(opened ? 'opened' : 'copied-only');
    })();
  };

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="autovox-link"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        title="Copy this brief and ask in ChatGPT or Claude. Uses their account, not an Autovox credit."
        onClick={() => {
          setStatus('idle');
          setOpen((value) => !value);
        }}
      >
        Ask
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className="follow-up"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          <label className="follow-up__legend" htmlFor={inputId}>
            Ask
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className="follow-up__question"
            type="text"
            maxLength={500}
            value={question}
            placeholder="Question about this brief"
            onChange={(event) => {
              setQuestion(event.target.value);
              setStatus('idle');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          <div className="follow-up__targets">
            {TARGETS.map((target, index) => (
              <span key={target.id} className="follow-up__target">
                {index > 0 ? (
                  <span className="autovox-actions__sep" aria-hidden="true">
                    ·
                  </span>
                ) : null}
                <button
                  type="button"
                  className="autovox-link"
                  title={`Copies the brief and opens ${target.label}. Their account answers.`}
                  onClick={() => handoff(target.id)}
                >
                  {target.label}
                </button>
              </span>
            ))}
          </div>
          {status === 'opened' ? (
            <p className="follow-up__status">Copied. Paste it in the new tab.</p>
          ) : null}
          {status === 'copied-only' ? (
            <p className="follow-up__status">
              Copied. The tab did not open.
            </p>
          ) : null}
          {status === 'failed' ? (
            <p className="follow-up__status follow-up__status--error">
              Copy failed
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
