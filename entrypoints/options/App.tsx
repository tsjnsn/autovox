import { useEffect, useState, type FormEvent } from 'react';
import { connectOpenRouter } from '../../utils/connect';
import { getSettings, saveSettings } from '../../utils/storage';
import {
  DEFAULT_SETTINGS,
  OUTPUT_LANGUAGES,
  VOICES,
  type OutputLanguage,
  type ReportLength,
  type Settings,
  type VoiceId,
} from '../../utils/types';

function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return '••••';
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  const connected = Boolean(settings.openRouterApiKey.trim());

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  const flash = (message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus(''), 2500);
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    await saveSettings(settings);
    flash('Saved.');
  };

  const onConnect = async () => {
    setConnectError('');
    setConnecting(true);
    try {
      const openRouterApiKey = await connectOpenRouter();
      const next = { ...settings, openRouterApiKey };
      setSettings(next);
      await saveSettings(next);
      flash('Connected.');
    } catch (error) {
      setConnectError(
        error instanceof Error ? error.message : 'Connect failed',
      );
    } finally {
      setConnecting(false);
    }
  };

  const onDisconnect = async () => {
    setConnectError('');
    const next = { ...settings, openRouterApiKey: '' };
    setSettings(next);
    await saveSettings(next);
    flash('Disconnected.');
  };

  return (
    <div className="page">
      <h1>Autovox</h1>
      <p className="lead">
        Connect OpenRouter, or paste an OpenAI key as fallback
      </p>

      <form className="form" onSubmit={(e) => void onSave(e)}>
        <section className="auth-block">
          <h2 className="auth-block__title">AI provider</h2>
          <p className="hint auth-block__copy">
            Preferred: Sign in with OpenRouter (OAuth). Your OpenRouter key stays
            on this browser profile — no backend required.
          </p>

          {connected ? (
            <div className="auth-block__status">
              <p className="auth-block__connected">Connected via OpenRouter</p>
              <p className="hint mono">{maskKey(settings.openRouterApiKey)}</p>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void onDisconnect()}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={connecting}
              onClick={() => void onConnect()}
            >
              {connecting ? 'Connecting…' : 'Connect with OpenRouter'}
            </button>
          )}

          {connectError ? <p className="hint warn">{connectError}</p> : null}
        </section>

        <label>
          OpenAI API key (fallback)
          <input
            type="password"
            autoComplete="off"
            value={settings.apiKey}
            onChange={(e) =>
              setSettings((s) => ({ ...s, apiKey: e.target.value }))
            }
            placeholder="sk-…"
          />
          <p className="hint">
            Used when OpenRouter is not connected. Calls OpenAI directly from
            this browser profile.
          </p>
        </label>

        <label>
          Voice
          <select
            value={settings.voice}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                voice: e.target.value as VoiceId,
              }))
            }
          >
            {VOICES.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
              </option>
            ))}
          </select>
          <p className="hint">
            Voices for gpt-audio-mini. Sage is a solid news-anchor default.
          </p>
        </label>

        <label>
          Output language
          <select
            value={settings.outputLanguage}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                outputLanguage: e.target.value as OutputLanguage,
              }))
            }
          >
            {OUTPUT_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
          <p className="hint">
            Auto matches the article&apos;s language. Choose a language to
            translate the report and narration. gpt-audio-mini supports the
            languages listed here; voices are English-optimized.
          </p>
        </label>

        <label>
          Report length
          <select
            value={settings.reportLength}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                reportLength: e.target.value as ReportLength,
              }))
            }
          >
            <option value="short">Short (~1–1.5 min)</option>
            <option value="standard">Standard (~2–3.5 min)</option>
            <option value="deep">Deep (~3.5–5 min)</option>
          </select>
        </label>

        <div className="actions">
          <button type="submit">Save</button>
          <span className="status">{status}</span>
        </div>
      </form>
    </div>
  );
}
