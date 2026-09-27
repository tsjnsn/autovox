import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import {
  Show,
  SignInButton,
  UserButton,
  useAuth,
} from '@clerk/chrome-extension';
import { hasLlmAuth, resolveLlmAuth, type LlmAuth } from '../../utils/auth';
import { connectOpenRouter } from '../../utils/connect';
import {
  isManagedConfigured,
  type ManagedAccountStatus,
} from '../../utils/managed';
import {
  formatUsd,
  MONEY_LEDGER_KEY,
  summarizeMoneyLedger,
  type MoneySummary,
} from '../../utils/money';
import {
  catalogModelId,
  DEFAULT_COMPREHENSION_MODEL,
  DEFAULT_TTS_MODEL,
  fetchModelCatalog,
  getCachedModelCatalog,
  MODEL_CATALOG_REFRESH_MS,
  modelOptions,
  saveModelCatalog,
  type ModelCatalog,
} from '../../utils/models';
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

function ManagedPanel({
  active,
  onUseManaged,
}: {
  active: boolean;
  onUseManaged: () => Promise<void>;
}) {
  const { isSignedIn } = useAuth();
  const [account, setAccount] = useState<ManagedAccountStatus | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (ensure = false) => {
    if (!isSignedIn) {
      setAccount(null);
      return;
    }
    const response = (await browser.runtime.sendMessage({
      type: ensure ? 'ENSURE_MANAGED_ACCOUNT' : 'GET_MANAGED_ACCOUNT',
    })) as {
      ok: boolean;
      status?: ManagedAccountStatus;
      error?: string;
    };
    if (response.ok && response.status) {
      setAccount(response.status);
      setError('');
    } else {
      setError(response.error ?? 'Could not load managed credits');
    }
  }, [isSignedIn]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const startCheckout = async () => {
    setBusy(true);
    setError('');
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'START_MANAGED_CHECKOUT',
      })) as { ok: boolean; error?: string };
      if (!response.ok) {
        throw new Error(response.error ?? 'Could not start checkout');
      }
    } catch (checkoutError) {
      setError(
        checkoutError instanceof Error
          ? checkoutError.message
          : 'Could not start checkout',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="managed-block">
      <div className="managed-block__heading">
        <div>
          <h2 className="auth-block__title">Managed listening</h2>
          <p className="hint">
            No provider account needed. Start with 3 funded briefs.
          </p>
        </div>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </div>

      <Show when="signed-out">
        <SignInButton mode="modal">
          <button type="button" className="btn-primary">
            Sign in
          </button>
        </SignInButton>
      </Show>

      <Show when="signed-in">
        <p className="managed-block__balance">
          {account
            ? `${account.availableCredits} credit${account.availableCredits === 1 ? '' : 's'} available`
            : 'Loading credits…'}
        </p>
        <p className="hint">
          Short and standard use 1 credit; deep uses 2. A credit is
          consumed only when the provider reports spend.
        </p>
        <div className="managed-block__actions">
          {!active ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => void onUseManaged()}
            >
              Use managed
            </button>
          ) : (
            <span className="managed-block__active">Active</span>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void startCheckout()}
          >
            {busy ? 'Opening…' : 'Buy 100 credits'}
          </button>
        </div>
      </Show>
      {error ? <p className="hint warn">{error}</p> : null}
    </section>
  );
}

/** Wait for typing to settle before fetching with a pasted key. */
const CATALOG_AUTH_DEBOUNCE_MS = 600;
/** Window focus refetches only when the catalog is older than this. */
const CATALOG_FOCUS_STALE_MS = 60 * 1000;

function catalogAuth(settings: Settings): LlmAuth | null {
  if (settings.providerMode !== 'byok' || !hasLlmAuth(settings)) return null;
  try {
    return resolveLlmAuth(settings);
  } catch {
    return null;
  }
}

function formatAge(fetchedAt: number, now: number): string {
  const minutes = Math.floor((now - fetchedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}

/** Live provider model list: cached, refetched on auth change, focus, and a timer. */
function useModelCatalog(auth: LlmAuth | null) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const catalogRef = useRef<ModelCatalog | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  catalogRef.current = catalog;

  const authMode = auth?.mode ?? null;
  const authKey = auth ? `${auth.mode}:${auth.apiKey}` : '';
  const authRef = useRef(auth);
  authRef.current = auth;

  const refresh = useCallback(async () => {
    const current = authRef.current;
    if (!current) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setLoading(true);
    try {
      const next = await fetchModelCatalog(current, abort.signal);
      if (abort.signal.aborted) return;
      setCatalog(next);
      setError('');
      setNow(Date.now());
      await saveModelCatalog(next);
    } catch (fetchError) {
      if (abort.signal.aborted) return;
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : 'Could not load models',
      );
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authMode) return;
    void getCachedModelCatalog().then((cached) => {
      if (cached?.source === authMode && !catalogRef.current) {
        setCatalog(cached);
      }
    });
  }, [authMode]);

  useEffect(() => {
    setCatalog((existing) =>
      existing && existing.source === authMode ? existing : null,
    );
    setError('');
    if (!authKey) {
      abortRef.current?.abort();
      setLoading(false);
      return;
    }
    const timer = window.setTimeout(
      () => void refresh(),
      CATALOG_AUTH_DEBOUNCE_MS,
    );
    const interval = window.setInterval(
      () => void refresh(),
      MODEL_CATALOG_REFRESH_MS,
    );
    const onFocus = () => {
      const fetchedAt = catalogRef.current?.fetchedAt ?? 0;
      if (Date.now() - fetchedAt > CATALOG_FOCUS_STALE_MS) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      abortRef.current?.abort();
    };
  }, [authKey, authMode, refresh]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  return { catalog, loading, error, now, refresh };
}

function ModelSelect({
  label,
  hint,
  value,
  fallback,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  fallback: string;
  options: ModelCatalog['comprehension'] | null;
  onChange: (model: string) => void;
}) {
  const selected = value || fallback;
  return (
    <label>
      {label}
      <select
        value={selected}
        disabled={!options}
        onChange={(e) => onChange(e.target.value)}
      >
        {modelOptions(options ?? [], selected).map((option) => (
          <option key={option.id} value={option.id}>
            {option.id === fallback || option.id === `openai/${fallback}`
              ? `${option.label} (default)`
              : option.label}
          </option>
        ))}
      </select>
      <p className="hint">{hint}</p>
    </label>
  );
}

function ModelsPanel({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
}) {
  const auth = catalogAuth(settings);
  const { catalog, loading, error, now, refresh } = useModelCatalog(auth);
  const source = catalog?.source ?? auth?.mode ?? null;
  const comprehension = source
    ? catalogModelId(source, settings.comprehensionModel)
    : settings.comprehensionModel;
  const tts = source ? catalogModelId(source, settings.ttsModel) : settings.ttsModel;
  const fallbackComprehension = source
    ? catalogModelId(source, DEFAULT_COMPREHENSION_MODEL)
    : DEFAULT_COMPREHENSION_MODEL;
  const fallbackTts = source
    ? catalogModelId(source, DEFAULT_TTS_MODEL)
    : DEFAULT_TTS_MODEL;

  let status: string;
  if (!auth) {
    status = 'Connect OpenRouter or add an OpenAI key to list models.';
  } else if (loading && !catalog) {
    status = 'Loading models…';
  } else if (catalog) {
    status = `${catalog.comprehension.length + catalog.tts.length} models from ${
      catalog.source === 'openrouter' ? 'OpenRouter' : 'OpenAI'
    } · updated ${formatAge(catalog.fetchedAt, now)}${loading ? ' · refreshing…' : ''}`;
  } else {
    status = 'Models not loaded yet.';
  }

  return (
    <section className="models-block" aria-labelledby="models-title">
      <div className="models-block__heading">
        <h2 id="models-title" className="auth-block__title">
          Models
        </h2>
        <button
          type="button"
          className="btn-secondary"
          disabled={!auth || loading}
          onClick={() => void refresh()}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="hint">{status}</p>
      {error ? <p className="hint warn">{error}</p> : null}

      <ModelSelect
        label="Comprehension model"
        hint="Reads the page and writes the report. Needs structured JSON output."
        value={comprehension}
        fallback={fallbackComprehension}
        options={catalog?.comprehension ?? null}
        onChange={(comprehensionModel) =>
          setSettings((s) => ({ ...s, comprehensionModel }))
        }
      />
      <ModelSelect
        label="Narration model"
        hint="Streams the spoken audio. Voices below are OpenAI audio voices."
        value={tts}
        fallback={fallbackTts}
        options={catalog?.tts ?? null}
        onChange={(ttsModel) => setSettings((s) => ({ ...s, ttsModel }))}
      />
      <button
        type="button"
        className="btn-link"
        onClick={() =>
          setSettings((s) => ({
            ...s,
            comprehensionModel: DEFAULT_COMPREHENSION_MODEL,
            ttsModel: DEFAULT_TTS_MODEL,
          }))
        }
      >
        Reset to defaults
      </button>
    </section>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [spend, setSpend] = useState<MoneySummary | null>(null);

  const connected = Boolean(settings.openRouterApiKey.trim());
  const managedAvailable = isManagedConfigured();

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    const loadSpend = () => {
      void summarizeMoneyLedger().then(setSpend);
    };
    loadSpend();
    const onChanged: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area === 'local' && changes[MONEY_LEDGER_KEY]) {
        loadSpend();
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
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
      const next = {
        ...settings,
        providerMode: 'byok' as const,
        openRouterApiKey,
      };
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

  const onUseManaged = async () => {
    const next = { ...settings, providerMode: 'managed' as const };
    setSettings(next);
    await saveSettings(next);
    flash('Managed listening active.');
  };

  const onUseByok = async () => {
    const next = { ...settings, providerMode: 'byok' as const };
    setSettings(next);
    await saveSettings(next);
    flash('Your provider active.');
  };

  return (
    <div className="page">
      <h1>Autovox</h1>
      <p className="lead">
        Choose funded managed listening or bring your own provider
      </p>

      <form className="form" onSubmit={(e) => void onSave(e)}>
        {managedAvailable ? (
          <ManagedPanel
            active={settings.providerMode === 'managed'}
            onUseManaged={onUseManaged}
          />
        ) : null}

        <section className="auth-block">
          <h2 className="auth-block__title">Bring your own provider</h2>
          <p className="hint auth-block__copy">
            OpenRouter OAuth or a pasted OpenAI key. Your key stays on this
            browser profile.
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
              {settings.providerMode !== 'byok' ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void onUseByok()}
                >
                  Use this provider
                </button>
              ) : null}
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
              setSettings((s) => ({
                ...s,
                providerMode: 'byok',
                apiKey: e.target.value,
              }))
            }
            placeholder="sk-…"
          />
          <p className="hint">
            Used when OpenRouter is not connected. Calls OpenAI directly from
            this browser profile.
          </p>
        </label>

        {settings.providerMode === 'byok' ? (
          <ModelsPanel settings={settings} setSettings={setSettings} />
        ) : (
          <p className="hint">
            Managed listening uses {DEFAULT_COMPREHENSION_MODEL} and{' '}
            {DEFAULT_TTS_MODEL}.
          </p>
        )}

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
            OpenAI audio voices. Sage is a solid news-anchor default.
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
            translate the report and narration. OpenAI audio models support the
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

      {settings.providerMode === 'byok' ? (
      <section className="spend" aria-labelledby="spend-title">
        <h2 id="spend-title" className="spend__title">
          Spend
        </h2>
        <p className="spend__hero">
          {spend
            ? `${formatUsd(spend.totalUsd)} across ${spend.briefCount} brief${spend.briefCount === 1 ? '' : 's'}`
            : 'This profile'}
        </p>
        <dl className="spend__meter">
          <div>
            <dt>Faults wasted</dt>
            <dd>{spend ? formatUsd(spend.wastedUsd) : '—'}</dd>
          </div>
          <div>
            <dt>Completed avg</dt>
            <dd>
              {spend?.averageCompletedUsd != null
                ? formatUsd(spend.averageCompletedUsd)
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Last 7 days</dt>
            <dd>{spend ? formatUsd(spend.last7dUsd) : '—'}</dd>
          </div>
        </dl>
        <p className="hint">
          Dollars on this profile only — Autovox never sees them. OpenRouter
          reports cost; a pasted OpenAI key usually cannot.
          {spend && spend.costUnknownCount > 0
            ? ` ${spend.costUnknownCount} event${spend.costUnknownCount === 1 ? '' : 's'} have no USD.`
            : ''}
        </p>
      </section>
      ) : null}
    </div>
  );
}
