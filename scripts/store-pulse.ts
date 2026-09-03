import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_META_PATH = resolve(ROOT, 'store/extension.json');
const DEFAULT_PULSE_PATH = resolve(ROOT, 'store/pulse.json');
const DEFAULT_MARKDOWN_PATH = resolve(ROOT, 'store/pulse.md');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GA_MEASUREMENT_RE = /^G-[A-Z0-9]+$/;

interface ExtensionMeta {
  id: string;
  name: string;
  listingUrl: string;
}

interface StoreReview {
  id: string;
  author: string;
  rating: number;
  text: string;
  createdAt: string;
  helpful: number;
}

interface StorePulse {
  fetchedAt: string;
  extensionId: string;
  name: string;
  listingUrl: string;
  reviewsUrl: string;
  version: string | null;
  userCount: number | null;
  rating: number | null;
  reviewCount: number | null;
  size: string | null;
  updatedAt: string | null;
  category: string | null;
  storeGaMeasurementId: string | null;
  privacyPolicyUrl: string | null;
  reviews: StoreReview[];
  previous: {
    fetchedAt: string;
    userCount: number | null;
    rating: number | null;
    reviewCount: number | null;
    version: string | null;
  } | null;
  deltas: {
    userCount: number | null;
    rating: number | null;
    reviewCount: number | null;
    newReviewIds: string[];
  };
  suggestedActions: string[];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readExtensionMeta(): ExtensionMeta {
  const raw = readJsonFile<unknown>(EXTENSION_META_PATH);
  const rec = asRecord(raw);
  if (
    !rec ||
    typeof rec.id !== 'string' ||
    typeof rec.name !== 'string' ||
    typeof rec.listingUrl !== 'string'
  ) {
    fail(`Invalid ${EXTENSION_META_PATH}`);
  }
  return { id: rec.id, name: rec.name, listingUrl: rec.listingUrl };
}

function parseArgs(argv: string[]): {
  writeJson: string;
  writeMarkdown: string | null;
} {
  let writeJson = DEFAULT_PULSE_PATH;
  let writeMarkdown: string | null = DEFAULT_MARKDOWN_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--write' && next) {
      writeJson = resolve(ROOT, next);
      i += 1;
    } else if (arg === '--markdown' && next) {
      writeMarkdown = resolve(ROOT, next);
      i += 1;
    } else if (arg === '--no-markdown') {
      writeMarkdown = null;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: pnpm pulse [--write store/pulse.json] [--markdown store/pulse.md] [--no-markdown]',
      );
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return { writeJson, writeMarkdown };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) {
    fail(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

function extractJsonArray(source: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(source.slice(start, i + 1)) as unknown;
      }
    }
  }
  throw new Error('Unbalanced JSON array in Chrome Web Store HTML');
}

function extractInitData(html: string): unknown[] {
  const payloads: unknown[] = [];
  const token = 'AF_initDataCallback(';
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf(token, cursor);
    if (start === -1) break;
    const dataAt = html.indexOf('data:', start);
    if (dataAt === -1 || dataAt - start > 200) {
      cursor = start + token.length;
      continue;
    }
    const arrayAt = html.indexOf('[', dataAt);
    if (arrayAt === -1) {
      cursor = start + token.length;
      continue;
    }
    payloads.push(extractJsonArray(html, arrayAt));
    cursor = arrayAt + 1;
  }
  if (payloads.length === 0) {
    fail('No AF_initDataCallback payloads found. Chrome Web Store HTML may have changed.');
  }
  return payloads;
}

function isListingPayload(
  data: unknown,
  extensionId: string,
): data is unknown[] {
  if (!Array.isArray(data) || data.length < 14) return false;
  const item = data[0];
  return (
    Array.isArray(item) &&
    item[0] === extensionId &&
    typeof item[2] === 'string'
  );
}

function unixPairToIso(value: unknown): string | null {
  if (!Array.isArray(value) || typeof value[0] !== 'number') return null;
  return new Date(value[0] * 1000).toISOString();
}

function parseListing(data: unknown[], extensionId: string): {
  name: string;
  rating: number | null;
  reviewCount: number | null;
  userCount: number | null;
  version: string | null;
  size: string | null;
  updatedAt: string | null;
  category: string | null;
  storeGaMeasurementId: string | null;
  privacyPolicyUrl: string | null;
} {
  const item = data[0];
  if (!Array.isArray(item)) {
    fail('Listing payload item[0] is not an array');
  }
  const rating = typeof item[3] === 'number' ? item[3] : null;
  const reviewCount = typeof item[4] === 'number' ? item[4] : null;
  const userCount = typeof item[14] === 'number' ? item[14] : null;
  const categoryRow = item[11];
  const category =
    Array.isArray(categoryRow) && typeof categoryRow[0] === 'string'
      ? categoryRow[0]
      : null;

  const version = typeof data[13] === 'string' ? data[13] : null;
  const size = typeof data[15] === 'string' ? data[15] : null;
  const updatedAt = unixPairToIso(data[14]);
  const storeGaMeasurementId =
    typeof data[25] === 'string' && GA_MEASUREMENT_RE.test(data[25])
      ? data[25]
      : null;
  const privacyPolicyUrl =
    typeof data[33] === 'string' && data[33].startsWith('http')
      ? data[33]
      : null;

  if (item[0] !== extensionId) {
    fail(`Listing id ${String(item[0])} did not match ${extensionId}`);
  }

  return {
    name: typeof item[2] === 'string' ? item[2] : 'Autovox',
    rating,
    reviewCount,
    userCount,
    version,
    size,
    updatedAt,
    category,
    storeGaMeasurementId,
    privacyPolicyUrl,
  };
}

function isReviewRow(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    typeof value[0] === 'string' &&
    UUID_RE.test(value[0]) &&
    typeof value[2] === 'number' &&
    typeof value[3] === 'string'
  );
}

function parseReview(row: unknown[]): StoreReview {
  const authorRow = row[1];
  const author =
    Array.isArray(authorRow) && typeof authorRow[0] === 'string'
      ? authorRow[0]
      : 'Anonymous';
  return {
    id: row[0] as string,
    author,
    rating: row[2] as number,
    text: (row[3] as string).trim(),
    createdAt: unixPairToIso(row[4]) ?? new Date(0).toISOString(),
    helpful: typeof row[6] === 'number' ? row[6] : 0,
  };
}

function extractReviews(payloads: unknown[]): StoreReview[] {
  for (const payload of payloads) {
    if (!Array.isArray(payload)) continue;
    for (const part of payload) {
      if (!Array.isArray(part) || part.length === 0) continue;
      if (!isReviewRow(part[0])) continue;
      return part.filter(isReviewRow).map(parseReview);
    }
  }
  return [];
}

function readPreviousPulse(path: string): StorePulse | null {
  try {
    const raw = readJsonFile<unknown>(path);
    const rec = asRecord(raw);
    if (!rec || typeof rec.fetchedAt !== 'string') return null;
    return raw as StorePulse;
  } catch {
    return null;
  }
}

function buildActions(input: {
  userCount: number | null;
  rating: number | null;
  reviewCount: number | null;
  reviews: StoreReview[];
  newReviewIds: string[];
  userDelta: number | null;
  ratingDelta: number | null;
}): string[] {
  const actions: string[] = [];
  const users = input.userCount ?? 0;
  const reviews = input.reviewCount ?? 0;

  if (users < 50 || reviews === 0) {
    actions.push(
      'Listing conversion is the bottleneck: expand the Chrome Web Store long description and screenshots before adding product surface area.',
    );
  }
  if (input.userDelta !== null && input.userDelta < 0) {
    actions.push(
      `User count dropped by ${Math.abs(input.userDelta)}. Check uninstall reasons in the Developer Dashboard and recent reviews.`,
    );
  }
  if (input.ratingDelta !== null && input.ratingDelta <= -0.2) {
    actions.push(
      `Average rating fell by ${input.ratingDelta.toFixed(2)}. Read new critical reviews and ship a focused fix.`,
    );
  }

  const newCritical = input.reviews.filter(
    (review) =>
      input.newReviewIds.includes(review.id) &&
      review.rating <= 3 &&
      review.text.length > 0,
  );
  for (const review of newCritical) {
    actions.push(
      `New ${review.rating}★ review from ${review.author}: “${truncate(review.text, 160)}” — file a GitHub issue and fix if it names a real product gap.`,
    );
  }

  if (actions.length === 0) {
    actions.push(
      'No urgent store-signal regressions. Re-read DESIGN.md and ship the smallest overlay improvement that helps people start a brief.',
    );
  }
  return actions;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatUsers(count: number | null): string {
  if (count === null) return 'unknown';
  return count.toLocaleString('en-US');
}

function formatRating(rating: number | null, reviewCount: number | null): string {
  if (rating === null) return 'unrated';
  const reviews = reviewCount === null ? '' : ` (${reviewCount} reviews)`;
  return `${rating.toFixed(2)} / 5${reviews}`;
}

function signed(delta: number | null): string {
  if (delta === null) return '—';
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function renderMarkdown(pulse: StorePulse): string {
  const reviewLines =
    pulse.reviews.length === 0
      ? '- _No public reviews yet._'
      : pulse.reviews
          .map((review) => {
            const fresh = pulse.deltas.newReviewIds.includes(review.id)
              ? ' **new**'
              : '';
            return `- ${review.rating}★${fresh} — ${review.author} (${review.createdAt.slice(0, 10)}): ${review.text}`;
          })
          .join('\n');

  const actions = pulse.suggestedActions
    .map((action) => `- ${action}`)
    .join('\n');

  return `# Store pulse — Autovox flywheel

Fetched **${pulse.fetchedAt}** from the public [Chrome Web Store listing](${pulse.listingUrl}).

| Signal | Now | Δ vs last pulse |
| --- | --- | --- |
| Users (public count) | ${formatUsers(pulse.userCount)} | ${signed(pulse.deltas.userCount)} |
| Rating | ${formatRating(pulse.rating, pulse.reviewCount)} | ${pulse.deltas.rating === null ? '—' : pulse.deltas.rating.toFixed(2)} |
| Reviews | ${pulse.reviewCount ?? 0} | ${signed(pulse.deltas.reviewCount)} |
| Listed version | ${pulse.version ?? 'unknown'} | ${pulse.previous?.version ?? '—'} → ${pulse.version ?? 'unknown'} |
| Last store update | ${pulse.updatedAt ?? 'unknown'} | |
| Category | ${pulse.category ?? 'unknown'} | |
| Size | ${pulse.size ?? 'unknown'} | |

This snapshot is **extrinsic** (store listing + public reviews). Autovox still has no backend and does not send product telemetry. See [docs/flywheel.md](../docs/flywheel.md).

${pulse.storeGaMeasurementId ? `CWS listing GA measurement id (store-page traffic, not in-extension events): \`${pulse.storeGaMeasurementId}\`.\n` : ''}
## Reviews

${reviewLines}

## Suggested actions

${actions}

<!-- flywheel-marker -->
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const meta = readExtensionMeta();
  const reviewsUrl = `${meta.listingUrl.replace(/\/$/, '')}/reviews`;

  const [listingHtml, reviewsHtml] = await Promise.all([
    fetchText(`${meta.listingUrl}?hl=en`),
    fetchText(`${reviewsUrl}?hl=en`),
  ]);

  const listingPayloads = extractInitData(listingHtml);
  const listing = listingPayloads.find((payload) =>
    isListingPayload(payload, meta.id),
  );
  if (!listing || !Array.isArray(listing)) {
    fail(`Could not find listing payload for ${meta.id}`);
  }
  const parsed = parseListing(listing, meta.id);
  const reviews = extractReviews(extractInitData(reviewsHtml));

  const previous = readPreviousPulse(args.writeJson);
  const previousReviewIds = new Set(previous?.reviews.map((review) => review.id) ?? []);
  const newReviewIds = reviews
    .map((review) => review.id)
    .filter((id) => !previousReviewIds.has(id));

  const userDelta =
    previous?.userCount != null && parsed.userCount != null
      ? parsed.userCount - previous.userCount
      : null;
  const ratingDelta =
    previous?.rating != null && parsed.rating != null
      ? parsed.rating - previous.rating
      : null;
  const reviewDelta =
    previous?.reviewCount != null && parsed.reviewCount != null
      ? parsed.reviewCount - previous.reviewCount
      : null;

  const pulse: StorePulse = {
    fetchedAt: new Date().toISOString(),
    extensionId: meta.id,
    name: parsed.name,
    listingUrl: meta.listingUrl,
    reviewsUrl,
    version: parsed.version,
    userCount: parsed.userCount,
    rating: parsed.rating,
    reviewCount: parsed.reviewCount,
    size: parsed.size,
    updatedAt: parsed.updatedAt,
    category: parsed.category,
    storeGaMeasurementId: parsed.storeGaMeasurementId,
    privacyPolicyUrl: parsed.privacyPolicyUrl,
    reviews,
    previous: previous
      ? {
          fetchedAt: previous.fetchedAt,
          userCount: previous.userCount,
          rating: previous.rating,
          reviewCount: previous.reviewCount,
          version: previous.version,
        }
      : null,
    deltas: {
      userCount: userDelta,
      rating: ratingDelta,
      reviewCount: reviewDelta,
      newReviewIds,
    },
    suggestedActions: buildActions({
      userCount: parsed.userCount,
      rating: parsed.rating,
      reviewCount: parsed.reviewCount,
      reviews,
      newReviewIds,
      userDelta,
      ratingDelta,
    }),
  };

  const metricsChanged =
    previous === null ||
    previous.userCount !== pulse.userCount ||
    previous.rating !== pulse.rating ||
    previous.reviewCount !== pulse.reviewCount ||
    previous.version !== pulse.version ||
    newReviewIds.length > 0 ||
    previous.reviews.length !== pulse.reviews.length;

  mkdirSync(dirname(args.writeJson), { recursive: true });
  writeFileSync(args.writeJson, `${JSON.stringify(pulse, null, 2)}\n`, 'utf8');
  if (args.writeMarkdown) {
    mkdirSync(dirname(args.writeMarkdown), { recursive: true });
    writeFileSync(args.writeMarkdown, renderMarkdown(pulse), 'utf8');
  }

  console.log(
    [
      `${pulse.name} ${pulse.extensionId}`,
      `users=${formatUsers(pulse.userCount)} rating=${formatRating(pulse.rating, pulse.reviewCount)} version=${pulse.version ?? '?'}`,
      `reviews=${pulse.reviews.length} new=${newReviewIds.length}`,
      `wrote ${args.writeJson}`,
      args.writeMarkdown ? `wrote ${args.writeMarkdown}` : null,
      `changed=${metricsChanged ? 'true' : 'false'}`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
  );
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : 'store-pulse failed');
});
