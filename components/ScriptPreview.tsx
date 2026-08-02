import { useState } from 'react';
import type { NewsReportScript } from '../utils/types';
import { scriptToSpokenText } from '../utils/understand';

export function ScriptPreview({ script }: { script: NewsReportScript }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="script">
      <button
        type="button"
        className="script__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? 'Hide script' : 'Show script'}
      </button>
      {open && (
        <div className="script__body">
          <h2 className="script__headline">{script.headline}</h2>
          <p className="script__meta">
            ~{Math.max(1, Math.round(script.estimatedSeconds / 60))} min
          </p>
          <div className="script__text">{scriptToSpokenText(script)}</div>
        </div>
      )}
    </section>
  );
}
