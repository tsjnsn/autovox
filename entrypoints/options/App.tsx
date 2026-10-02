import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
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
  DEFAULT_DRAWING_MODEL,
  DEFAULT_TTS_MODEL,
  fetchModelCatalog,
  getCachedModelCatalog,
  COST_UNIT,
  estimateCost,
  formatCost,
  MODEL_CATALOG_REFRESH_MS,
  MODEL_PICKS,
  modelChoices,
  saveModelCatalog,
  searchModels,
  type ModelCatalog,
  type ModelOption,
  type ModelRole,
  type QualityLevel,
} from '../../utils/models';
import { OUTPUT_LANGUAGES, type OutputLanguage } from '../../utils/languages';
import { getSettings, saveSettings } from '../../utils/storage';
import {
  DEFAULT_SETTINGS,
  VOICES,
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
          <h2 className="auth-block__title">Autovox credits</h2>
          <p className="hint">
            No AI provider account needed. You start with 3 free credits.
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
          Short and standard briefs use 1 credit, deep briefs use 2. A brief
          only uses credits once the AI provider has charged for it.
        </p>
        <div className="managed-block__actions">
          {!active ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => void onUseManaged()}
            >
              Use credits
            </button>
          ) : (
            <span className="managed-block__active">In use</span>
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

/** Rendering every OpenRouter model at once is slow; search narrows the rest. */
const MAX_BROWSE_RESULTS = 60;

function QualityBar({ level }: { level: QualityLevel }) {
  return (
    <span className="quality" role="img" aria-label={`Quality ${level} of 5`}>
      {[1, 2, 3, 4, 5].map((step) => (
        <i key={step} className={step <= level ? 'on' : undefined} />
      ))}
    </span>
  );
}

function ModelRow({
  name,
  id,
  tag,
  note,
  quality,
  cost,
  checked,
  onSelect,
}: {
  name: string;
  id?: string;
  tag?: string;
  note?: string;
  quality?: QualityLevel;
  /** Formatted estimate, e.g. "~$0.09 / lesson". */
  cost?: string | null;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={`model-row${checked ? ' model-row--checked' : ''}`}
      onClick={onSelect}
    >
      <span className="model-row__top">
        <span className="model-row__name">{name}</span>
        {tag ? <span className="model-row__tag">{tag}</span> : null}
        {quality ? <QualityBar level={quality} /> : null}
        {cost ? <span className="model-row__cost">{cost}</span> : null}
      </span>
      {note ? <span className="model-row__note">{note}</span> : null}
      {id && id !== name ? <span className="model-row__id">{id}</span> : null}
    </button>
  );
}

function ModelPicker({
  label,
  hint,
  role,
  source,
  value,
  fallback,
  inheritLabel,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  role: ModelRole;
  source: LlmAuth['mode'] | null;
  /** Selected id in the catalog's format; empty means default (or inherit). */
  value: string;
  /** The default model; marked in the list. */
  fallback: string;
  /** When set, an empty value is offered as this choice instead of the fallback. */
  inheritLabel?: string;
  options: ModelOption[] | null;
  onChange: (model: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState('');
  const selected = inheritLabel ? value : value || fallback;
  const { recommended, others } = modelChoices(
    source ?? 'openrouter',
    options ?? [],
    source ? MODEL_PICKS[role] : [],
  );
  const selectedOption = options?.find((option) => option.id === selected);
  const selectedIsShortlisted = recommended.some((pick) => pick.id === selected);
  const unlisted = Boolean(options && selected && !selectedOption);
  const matches = searchModels(others, query);
  const hasPrices = (options ?? []).some((option) => option.price);
  const costOf = (option: ModelOption | undefined) => {
    const usd = estimateCost(role, option?.price);
    return usd === null ? null : `${formatCost(usd)} / ${COST_UNIT[role]}`;
  };

  const applyCustom = () => {
    const id = custom.trim();
    if (!id) return;
    onChange(id);
    setCustom('');
  };

  return (
    <fieldset className="model-picker">
      <legend>{label}</legend>
      <p className="hint">{hint}</p>
      <div className="model-picker__list" role="radiogroup" aria-label={label}>
        {inheritLabel ? (
          <ModelRow
            name={inheritLabel}
            checked={value === ''}
            onSelect={() => onChange('')}
          />
        ) : null}
        {recommended.map((pick) => (
          <ModelRow
            key={pick.id}
            name={pick.label}
            id={pick.id}
            tag={
              pick.id === fallback && pick.tag.toLowerCase() !== 'default'
                ? `${pick.tag} · default`
                : pick.tag
            }
            note={pick.note}
            quality={pick.quality}
            cost={costOf(pick)}
            checked={pick.id === selected}
            onSelect={() => onChange(pick.id)}
          />
        ))}
        {selected && !selectedIsShortlisted ? (
          <ModelRow
            name={selectedOption?.label ?? selected}
            id={selected}
            tag="Your pick"
            note={
              unlisted
                ? 'Not in your provider’s current list; it will be tried as typed and may fail.'
                : undefined
            }
            cost={costOf(selectedOption)}
            checked
            onSelect={() => onChange(selected)}
          />
        ) : null}
      </div>

      <details className="model-picker__more">
        <summary>
          {options ? `Browse all ${options.length} models` : 'Browse all models'}
          {' · '}or type an ID
        </summary>
        <input
          type="search"
          className="model-picker__search"
          placeholder="Search by name or id"
          aria-label={`Search ${label.toLowerCase()} options`}
          value={query}
          disabled={!options}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="model-picker__results" role="radiogroup" aria-label={`All ${label.toLowerCase()} options`}>
          {matches.slice(0, MAX_BROWSE_RESULTS).map((option) => (
            <ModelRow
              key={option.id}
              name={option.label}
              id={option.id}
              cost={costOf(option)}
              checked={option.id === selected}
              onSelect={() => onChange(option.id)}
            />
          ))}
          {matches.length > MAX_BROWSE_RESULTS ? (
            <p className="hint">
              Showing {MAX_BROWSE_RESULTS} of {matches.length}. Search to narrow.
            </p>
          ) : null}
          {options && matches.length === 0 ? (
            <p className="hint">No models match. You can still type an ID below.</p>
          ) : null}
        </div>
        <div className="model-picker__custom">
          <input
            type="text"
            placeholder="Any model ID, e.g. vendor/model-name"
            aria-label={`Custom ${label.toLowerCase()} id`}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyCustom();
              }
            }}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={!custom.trim()}
            onClick={applyCustom}
          >
            Use
          </button>
        </div>
      </details>
      {hasPrices ? (
        <p className="hint">Costs are rough estimates for a typical {COST_UNIT[role]}.</p>
      ) : null}
    </fieldset>
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
  const drawing =
    source && settings.drawingModel
      ? catalogModelId(source, settings.drawingModel)
      : settings.drawingModel;
  const tts = source ? catalogModelId(source, settings.ttsModel) : settings.ttsModel;
  const fallbackComprehension = source
    ? catalogModelId(source, DEFAULT_COMPREHENSION_MODEL)
    : DEFAULT_COMPREHENSION_MODEL;
  const fallbackDrawing = source
    ? catalogModelId(source, DEFAULT_DRAWING_MODEL)
    : DEFAULT_DRAWING_MODEL;
  const fallbackTts = source
    ? catalogModelId(source, DEFAULT_TTS_MODEL)
    : DEFAULT_TTS_MODEL;

  let status: string;
  if (!auth) {
    status = 'Connect OpenRouter or add an OpenAI key to choose models.';
  } else if (loading && !catalog) {
    status = 'Loading models…';
  } else if (catalog) {
    status = `${catalog.comprehension.length + catalog.tts.length} models from ${
      catalog.source === 'openrouter' ? 'OpenRouter' : 'OpenAI'
    }, updated ${formatAge(catalog.fetchedAt, now)}.`;
  } else {
    status = 'Models haven’t loaded. Try Refresh.';
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

      <ModelPicker
        label="Writing model"
        hint="Reads the page and writes the report or lesson script. Needs structured output."
        role="writing"
        source={source}
        value={comprehension}
        fallback={fallbackComprehension}
        options={catalog?.comprehension ?? null}
        onChange={(comprehensionModel) =>
          setSettings((s) => ({ ...s, comprehensionModel }))
        }
      />
      <ModelPicker
        label="Chalkboard drawing model"
        hint="Lays out each chalkboard scene. Stronger models compose much better boards; drawing is most of a lesson’s cost."
        role="drawing"
        source={source}
        value={drawing}
        fallback={fallbackDrawing}
        inheritLabel="Same as writing model"
        options={catalog?.comprehension ?? null}
        onChange={(drawingModel) => setSettings((s) => ({ ...s, drawingModel }))}
      />
      <ModelPicker
        label="Narration model"
        hint="Reads the report aloud."
        role="narration"
        source={source}
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
            drawingModel: DEFAULT_DRAWING_MODEL,
            ttsModel: DEFAULT_TTS_MODEL,
          }))
        }
      >
        Reset to defaults
      </button>
    </section>
  );
}

function SpendPanel({ spend }: { spend: MoneySummary | null }) {
  return (
    <section className="spend" aria-labelledby="spend-title">
      <h2 id="spend-title" className="spend__title">
        Spend
      </h2>
      <p className="spend__hero">
        {!spend
          ? '—'
          : spend.briefCount === 0
            ? 'No briefs yet.'
            : `${formatUsd(spend.totalUsd)} across ${spend.briefCount} brief${spend.briefCount === 1 ? '' : 's'}`}
      </p>
      <dl className="spend__meter">
        <div>
          <dt>Last 7 days</dt>
          <dd>{spend ? formatUsd(spend.last7dUsd) : '—'}</dd>
        </div>
        <div>
          <dt>Average brief</dt>
          <dd>
            {spend?.averageCompletedUsd != null
              ? formatUsd(spend.averageCompletedUsd)
              : '—'}
          </dd>
        </div>
        <div>
          <dt>Spent on failed briefs</dt>
          <dd>{spend ? formatUsd(spend.wastedUsd) : '—'}</dd>
        </div>
      </dl>
      <p className="hint">
        Tracked in this browser profile only; Autovox never receives it.
        OpenRouter reports what each brief cost. OpenAI keys usually don’t, so
        those briefs aren’t counted.
        {spend && spend.costUnknownCount > 0
          ? ` ${spend.costUnknownCount} ${spend.costUnknownCount === 1 ? 'charge has' : 'charges have'} no known cost.`
          : ''}
      </p>
    </section>
  );
}

const REPORT_LENGTHS: { id: ReportLength; label: string; minutes: string }[] = [
  { id: 'short', label: 'Short', minutes: '1–1.5 min' },
  { id: 'standard', label: 'Standard', minutes: '2–3.5 min' },
  { id: 'deep', label: 'Deep', minutes: '3.5–5 min' },
];

/** Settings changes are written after typing pauses this long. */
const AUTOSAVE_DELAY_MS = 400;

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [spend, setSpend] = useState<MoneySummary | null>(null);
  const skipAutosaveRef = useRef(true);
  const pendingSaveRef = useRef<Settings | null>(null);
  const settingsRef = useRef(settings);
  const flashTimerRef = useRef(0);

  const connected = Boolean(settings.openRouterApiKey.trim());
  const managedAvailable = isManagedConfigured();

  useEffect(() => {
    void getSettings().then((stored) => {
      setSettings(stored);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    if (!loaded) return;
    if (skipAutosaveRef.current) {
      skipAutosaveRef.current = false;
      return;
    }
    pendingSaveRef.current = settings;
    const timer = window.setTimeout(() => {
      pendingSaveRef.current = null;
      void saveSettings(settings).then(() => flash('Saved'));
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [settings, loaded]);

  useEffect(() => {
    const flush = () => {
      const pending = pendingSaveRef.current;
      if (!pending) return;
      pendingSaveRef.current = null;
      void saveSettings(pending);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
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
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setStatus(''), 2500);
  };

  /** Saves immediately with its own message instead of the autosave's. */
  const commit = async (next: Settings, message: string) => {
    skipAutosaveRef.current = true;
    pendingSaveRef.current = null;
    setSettings(next);
    await saveSettings(next);
    flash(message);
  };

  const onConnect = async () => {
    setConnectError('');
    setConnecting(true);
    try {
      const openRouterApiKey = await connectOpenRouter();
      await commit(
        { ...settingsRef.current, providerMode: 'byok', openRouterApiKey },
        'Connected',
      );
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
    await commit({ ...settings, openRouterApiKey: '' }, 'Disconnected');
  };

  const onUseManaged = () =>
    commit({ ...settings, providerMode: 'managed' }, 'Using Autovox credits');

  const onUseByok = () =>
    commit({ ...settings, providerMode: 'byok' }, 'Using your provider');

  return (
    <div className="page">
      <header className="page__header">
        <h1>Autovox</h1>
        <span className="status" role="status">
          {status}
        </span>
      </header>

      <main className="panel">
        <div className="panel__col panel__col--account">
          {managedAvailable ? (
            <ManagedPanel
              active={settings.providerMode === 'managed'}
              onUseManaged={onUseManaged}
            />
          ) : null}

          <section className="auth-block">
            <h2 className="auth-block__title">Bring your own provider</h2>
            <p className="hint auth-block__copy">
              Connect OpenRouter, or paste an OpenAI key. Keys stay in this
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

            <label>
              OpenAI API key
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
                Used only when OpenRouter isn’t connected.
              </p>
            </label>
          </section>

          {settings.providerMode === 'byok' ? (
            <SpendPanel spend={spend} />
          ) : null}
        </div>

        <div className="panel__col panel__col--listening">
          <section className="listening" aria-labelledby="listening-title">
            <h2 id="listening-title" className="auth-block__title">
              Listening
            </h2>

            <fieldset className="choice-group">
              <legend>Voice</legend>
              <div className="choices choices--voices">
                {VOICES.map((voice) => (
                  <label key={voice.id} className="choice">
                    <input
                      type="radio"
                      name="voice"
                      value={voice.id}
                      checked={settings.voice === voice.id}
                      onChange={() =>
                        setSettings((s) => ({ ...s, voice: voice.id as VoiceId }))
                      }
                    />
                    <span className="choice__face">{voice.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="choice-group">
              <legend>Report length</legend>
              <div className="choices choices--lengths">
                {REPORT_LENGTHS.map((length) => (
                  <label key={length.id} className="choice">
                    <input
                      type="radio"
                      name="reportLength"
                      value={length.id}
                      checked={settings.reportLength === length.id}
                      onChange={() =>
                        setSettings((s) => ({ ...s, reportLength: length.id }))
                      }
                    />
                    <span className="choice__face">
                      {length.label}
                      <span className="choice__detail">{length.minutes}</span>
                    </span>
                  </label>
                ))}
              </div>
              {managedAvailable ? (
                <p className="hint">Deep briefs use 2 credits.</p>
              ) : null}
            </fieldset>

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
              Auto uses the article&apos;s language. Pick another to translate
              the report. Voices sound most natural in English.
            </p>
          </label>

          </section>

          {settings.providerMode === 'byok' ? (
            <ModelsPanel settings={settings} setSettings={setSettings} />
          ) : (
            <p className="hint">
              Credits use {DEFAULT_COMPREHENSION_MODEL} to write and{' '}
              {DEFAULT_TTS_MODEL} to narrate.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
