import type { ReportLength } from './types';

/** Fields whose text is spoken, in the order the writing model emits them. */
export const BRIEF_DRAFT_KEYS: ReadonlySet<string> = new Set(['headline', 'lede', 'segments']);
export const LESSON_DRAFT_KEYS: ReadonlySet<string> = new Set(['title', 'heading', 'say']);

/** Tops of the spoken-length ranges given to the writing models. */
export const DRAFT_TARGET_WORDS: Record<ReportLength, number> = {
  short: 220,
  standard: 550,
  deep: 800,
};

const DRAFT_SEPARATOR = ' — ';

const ESCAPES: Record<string, string> = {
  n: ' ',
  r: ' ',
  t: ' ',
  b: '',
  f: '',
};

type Frame =
  | { kind: 'object'; key: string | null; expectKey: boolean }
  | { kind: 'array'; key: string | null };

/**
 * String values under `keys` from a JSON document that may be cut off
 * mid-stream. The last value may be partial; an incomplete escape is dropped,
 * so each call's result extends the previous one as more JSON arrives.
 */
export function draftStrings(json: string, keys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const stack: Frame[] = [];
  let i = 0;
  while (i < json.length) {
    const ch = json[i];
    if (ch === '"') {
      let value = '';
      let j = i + 1;
      let closed = false;
      while (j < json.length) {
        const c = json[j]!;
        if (c === '\\') {
          const next = json[j + 1];
          if (next === undefined) break;
          if (next === 'u') {
            const hex = json.slice(j + 2, j + 6);
            if (hex.length < 4) break;
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          value += ESCAPES[next] ?? next;
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          j++;
          break;
        }
        value += c;
        j++;
      }
      const top = stack.at(-1);
      if (top?.kind === 'object' && top.expectKey) {
        if (closed) top.key = value;
      } else if (top?.key && keys.has(top.key)) {
        out.push(value);
      }
      if (!closed) break;
      i = j;
      continue;
    }
    const top = stack.at(-1);
    if (ch === '{') {
      stack.push({ kind: 'object', key: null, expectKey: true });
    } else if (ch === '[') {
      stack.push({ kind: 'array', key: top?.key ?? null });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ':' && top?.kind === 'object') {
      top.expectKey = false;
    } else if (ch === ',' && top?.kind === 'object') {
      top.expectKey = true;
      top.key = null;
    }
    i++;
  }
  return out;
}

/** The spoken text written so far, as one line. */
export function draftText(json: string, keys: ReadonlySet<string>): string {
  return draftStrings(json, keys)
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(DRAFT_SEPARATOR);
}

const wordSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

/** Word count that also works for languages written without spaces. */
export function countWords(text: string): number {
  if (!wordSegmenter) return text.split(/\s+/).filter(Boolean).length;
  let count = 0;
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike) count++;
  }
  return count;
}
