import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = resolve(ROOT, 'store/money-pulse.json');

const ANALYTICS_URL = 'https://openrouter.ai/api/v1/analytics/query';

interface MoneyPulse {
  fetchedAt: string;
  status: 'ok' | 'no_management_key' | 'error';
  note: string;
  totalUsd: number | null;
  requestCount: number | null;
  byModel: Array<{ model: string; totalUsd: number; requestCount: number }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function writePulse(pulse: MoneyPulse): void {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(pulse, null, 2)}\n`);
}

function emptyPulse(
  status: MoneyPulse['status'],
  note: string,
): MoneyPulse {
  return {
    fetchedAt: new Date().toISOString(),
    status,
    note,
    totalUsd: null,
    requestCount: null,
    byModel: [],
  };
}

const key = process.env.OPENROUTER_MANAGEMENT_KEY?.trim() ?? '';
if (!key) {
  const pulse = emptyPulse(
    'no_management_key',
    'Company money pulse needs an Autovox-owned OpenRouter management key. BYOK spend stays on the user profile ledger. See docs/flywheel.md.',
  );
  writePulse(pulse);
  console.log('status=no_management_key');
  process.exit(0);
}

const end = new Date();
const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

let response: Response;
try {
  response = await fetch(ANALYTICS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      metrics: ['total_usage', 'request_count'],
      dimensions: ['model'],
      order_by: { field: 'total_usage', direction: 'desc' },
      time_range: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      limit: 25,
    }),
  });
} catch (error) {
  const pulse = emptyPulse(
    'error',
    error instanceof Error ? error.message : 'Analytics request failed',
  );
  writePulse(pulse);
  console.error(pulse.note);
  process.exit(1);
}

if (!response.ok) {
  const body = await response.text();
  const pulse = emptyPulse(
    'error',
    `OpenRouter analytics ${response.status}: ${body.slice(0, 240)}`,
  );
  writePulse(pulse);
  console.error(pulse.note);
  process.exit(1);
}

const payload: unknown = await response.json();
const root = asRecord(payload);
const rows = Array.isArray(root?.data)
  ? root.data
  : Array.isArray(root?.rows)
    ? root.rows
    : [];

const byModel: MoneyPulse['byModel'] = [];
for (const row of rows) {
  const rec = asRecord(row);
  if (!rec) continue;
  const model =
    (typeof rec.model === 'string' && rec.model) ||
    (typeof rec.model__ === 'string' && rec.model__) ||
    'unknown';
  const totalUsd =
    asFiniteNumber(rec.total_usage) ?? asFiniteNumber(rec.totalUsd) ?? 0;
  const requestCount =
    asFiniteNumber(rec.request_count) ?? asFiniteNumber(rec.requestCount) ?? 0;
  byModel.push({ model, totalUsd, requestCount });
}

const pulse: MoneyPulse = {
  fetchedAt: new Date().toISOString(),
  status: 'ok',
  note: 'Autovox-owned OpenRouter spend for the last 30 days. This is the company flywheel dataset.',
  totalUsd: byModel.reduce((sum, row) => sum + row.totalUsd, 0),
  requestCount: byModel.reduce((sum, row) => sum + row.requestCount, 0),
  byModel,
};

writePulse(pulse);
console.log(`status=ok totalUsd=${pulse.totalUsd} requests=${pulse.requestCount}`);
