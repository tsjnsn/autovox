import type { LlmAuth } from './auth';
import type { ProviderUsage } from './usage';
import type { OutputLanguage, ReportLength, VoiceId } from './types';

export const MONEY_LEDGER_KEY = 'autovoxMoneyLedger';
export const MONEY_LEDGER_VERSION = 1;
const MAX_EVENTS = 200;
const STALE_OPEN_MS = 60 * 60 * 1000;

export type MoneyOutcome = 'open' | 'completed' | 'fault' | 'aborted';
export type MoneyFaultStage = 'extract' | 'understand' | 'tts' | 'none';
export type MoneyEventKind = 'brief' | 'tts_replay';
export type MoneyAuthMode = LlmAuth['mode'] | 'managed';

export type MoneyLineItem = {
  kind: 'understand' | 'tts';
  model: string;
  costUsd: number | null;
  costKnown: boolean;
  generationId?: string;
};

export type MoneyEvent = {
  id: string;
  kind: MoneyEventKind;
  startedAt: number;
  endedAt: number | null;
  outcome: MoneyOutcome;
  faultStage: MoneyFaultStage;
  costUsd: number;
  costKnown: boolean;
  lineItems: MoneyLineItem[];
  reportLength: ReportLength;
  voice: VoiceId;
  outputLanguage: OutputLanguage;
  authMode: MoneyAuthMode;
};

export type MoneySessionDims = {
  kind?: MoneyEventKind;
  reportLength: ReportLength;
  voice: VoiceId;
  outputLanguage: OutputLanguage;
  authMode: MoneyAuthMode;
};

export type MoneySummary = {
  eventCount: number;
  briefCount: number;
  completedCount: number;
  faultCount: number;
  abortedCount: number;
  openCount: number;
  totalUsd: number;
  wastedUsd: number;
  completedUsd: number;
  last7dUsd: number;
  costKnownCount: number;
  costUnknownCount: number;
  averageCompletedUsd: number | null;
};

type Ledger = {
  version: typeof MONEY_LEDGER_VERSION;
  events: MoneyEvent[];
};

function emptyLedger(): Ledger {
  return { version: MONEY_LEDGER_VERSION, events: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAuthMode(value: unknown): value is MoneyAuthMode {
  return (
    value === 'openrouter' ||
    value === 'apiKey' ||
    value === 'managed'
  );
}

function isOutcome(value: unknown): value is MoneyOutcome {
  return (
    value === 'open' ||
    value === 'completed' ||
    value === 'fault' ||
    value === 'aborted'
  );
}

function isFaultStage(value: unknown): value is MoneyFaultStage {
  return (
    value === 'extract' ||
    value === 'understand' ||
    value === 'tts' ||
    value === 'none'
  );
}

function isEventKind(value: unknown): value is MoneyEventKind {
  return value === 'brief' || value === 'tts_replay';
}

function isLineItem(value: unknown): value is MoneyLineItem {
  const rec = asRecord(value);
  if (!rec) return false;
  if (rec.kind !== 'understand' && rec.kind !== 'tts') return false;
  if (typeof rec.model !== 'string' || rec.model.trim() === '') return false;
  if (typeof rec.costKnown !== 'boolean') return false;
  if (rec.costUsd !== null && typeof rec.costUsd !== 'number') return false;
  if (
    rec.generationId !== undefined &&
    typeof rec.generationId !== 'string'
  ) {
    return false;
  }
  return true;
}

function isMoneyEvent(value: unknown): value is MoneyEvent {
  const rec = asRecord(value);
  if (!rec) return false;
  if (typeof rec.id !== 'string' || rec.id.trim() === '') return false;
  if (!isEventKind(rec.kind)) return false;
  if (typeof rec.startedAt !== 'number' || !Number.isFinite(rec.startedAt)) {
    return false;
  }
  if (rec.endedAt !== null && typeof rec.endedAt !== 'number') return false;
  if (!isOutcome(rec.outcome)) return false;
  if (!isFaultStage(rec.faultStage)) return false;
  if (typeof rec.costUsd !== 'number' || !Number.isFinite(rec.costUsd)) {
    return false;
  }
  if (typeof rec.costKnown !== 'boolean') return false;
  if (!Array.isArray(rec.lineItems) || !rec.lineItems.every(isLineItem)) {
    return false;
  }
  if (typeof rec.reportLength !== 'string') return false;
  if (typeof rec.voice !== 'string') return false;
  if (typeof rec.outputLanguage !== 'string') return false;
  if (!isAuthMode(rec.authMode)) return false;
  return true;
}

function coerceLedger(value: unknown): Ledger {
  const rec = asRecord(value);
  if (!rec || !Array.isArray(rec.events)) return emptyLedger();
  return {
    version: MONEY_LEDGER_VERSION,
    events: rec.events.filter(isMoneyEvent),
  };
}

function totalsFromItems(items: MoneyLineItem[]): {
  costUsd: number;
  costKnown: boolean;
} {
  let costUsd = 0;
  let sawKnown = false;
  let sawUnknown = false;
  for (const item of items) {
    if (item.costKnown && item.costUsd !== null) {
      costUsd += item.costUsd;
      sawKnown = true;
    } else {
      sawUnknown = true;
    }
  }
  return {
    costUsd,
    costKnown: items.length === 0 ? true : sawKnown && !sawUnknown,
  };
}

function applyTotals(event: MoneyEvent): void {
  const totals = totalsFromItems(event.lineItems);
  event.costUsd = totals.costUsd;
  event.costKnown = totals.costKnown;
}

function trimLedger(ledger: Ledger): void {
  if (ledger.events.length <= MAX_EVENTS) return;
  ledger.events.sort((a, b) => a.startedAt - b.startedAt);
  ledger.events = ledger.events.slice(ledger.events.length - MAX_EVENTS);
}

function sweepStale(ledger: Ledger, now: number): void {
  for (const event of ledger.events) {
    if (event.outcome !== 'open') continue;
    if (now - event.startedAt < STALE_OPEN_MS) continue;
    event.outcome = 'aborted';
    event.endedAt = now;
    event.faultStage = 'none';
  }
}

async function readLedger(): Promise<Ledger> {
  const stored = await browser.storage.local.get(MONEY_LEDGER_KEY);
  return coerceLedger(stored[MONEY_LEDGER_KEY]);
}

async function writeLedger(ledger: Ledger): Promise<void> {
  trimLedger(ledger);
  await browser.storage.local.set({ [MONEY_LEDGER_KEY]: ledger });
}

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function withLedger<T>(fn: (ledger: Ledger) => T): Promise<T> {
  return enqueue(async () => {
    const ledger = await readLedger();
    sweepStale(ledger, Date.now());
    const result = fn(ledger);
    await writeLedger(ledger);
    return result;
  });
}

export function usageToLineItem(
  kind: MoneyLineItem['kind'],
  model: string,
  usage: ProviderUsage,
): MoneyLineItem {
  return {
    kind,
    model,
    costUsd: usage.costUsd,
    costKnown: usage.costKnown,
    generationId: usage.generationId,
  };
}

export async function startMoneySession(
  dims: MoneySessionDims,
): Promise<string> {
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  return withLedger((ledger) => {
    ledger.events.push({
      id,
      kind: dims.kind ?? 'brief',
      startedAt,
      endedAt: null,
      outcome: 'open',
      faultStage: 'none',
      costUsd: 0,
      costKnown: true,
      lineItems: [],
      reportLength: dims.reportLength,
      voice: dims.voice,
      outputLanguage: dims.outputLanguage,
      authMode: dims.authMode,
    });
    return id;
  });
}

export async function getMoneyEvent(
  id: string,
): Promise<MoneyEvent | null> {
  const ledger = await readLedger();
  return ledger.events.find((event) => event.id === id) ?? null;
}

export async function addMoneyLine(
  id: string,
  item: MoneyLineItem,
): Promise<void> {
  await withLedger((ledger) => {
    const event = ledger.events.find((row) => row.id === id);
    if (!event) return;
    event.lineItems.push(item);
    applyTotals(event);
  });
}

export async function finishMoneySession(
  id: string,
  outcome: Exclude<MoneyOutcome, 'open'>,
  faultStage: MoneyFaultStage = 'none',
): Promise<void> {
  await withLedger((ledger) => {
    const event = ledger.events.find((row) => row.id === id);
    if (!event || event.outcome !== 'open') return;
    event.outcome = outcome;
    event.endedAt = Date.now();
    event.faultStage = outcome === 'fault' ? faultStage : 'none';
    applyTotals(event);
  });
}

export function summarizeMoneyEvents(
  events: readonly MoneyEvent[],
  now: number,
): MoneySummary {
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  let briefCount = 0;
  let completedCount = 0;
  let faultCount = 0;
  let abortedCount = 0;
  let openCount = 0;
  let totalUsd = 0;
  let wastedUsd = 0;
  let completedUsd = 0;
  let completedKnown = 0;
  let last7dUsd = 0;
  let costKnownCount = 0;
  let costUnknownCount = 0;

  for (const event of events) {
    if (event.kind === 'brief') briefCount += 1;
    if (event.outcome === 'completed') completedCount += 1;
    if (event.outcome === 'fault') faultCount += 1;
    if (event.outcome === 'aborted') abortedCount += 1;
    if (event.outcome === 'open') openCount += 1;

    if (event.costKnown) {
      costKnownCount += 1;
      totalUsd += event.costUsd;
      if (event.startedAt >= weekAgo) last7dUsd += event.costUsd;
      if (event.outcome === 'fault') wastedUsd += event.costUsd;
      if (event.outcome === 'completed') {
        completedUsd += event.costUsd;
        completedKnown += 1;
      }
    } else {
      costUnknownCount += 1;
    }
  }

  return {
    eventCount: events.length,
    briefCount,
    completedCount,
    faultCount,
    abortedCount,
    openCount,
    totalUsd,
    wastedUsd,
    completedUsd,
    last7dUsd,
    costKnownCount,
    costUnknownCount,
    averageCompletedUsd:
      completedKnown > 0 ? completedUsd / completedKnown : null,
  };
}

export async function summarizeMoneyLedger(): Promise<MoneySummary> {
  return withLedger((ledger) => summarizeMoneyEvents(ledger.events, Date.now()));
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (amount === 0) return '$0.00';
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
