import { creditsForSession, type SessionKind } from '../convex/lib/economics';
import type { SessionFormat } from './chalk/types';
import type { ExtractedArticle, ReportLength } from './types';

/**
 * Article types steer comprehension: what to pull out of the page, the arc and
 * voice of the narration, the narrator's delivery, and what a chalkboard's
 * boards show. "Infer" has the writing model pick one in the same request.
 */
export const ARTICLE_TYPES = [
  'news',
  'feature',
  'explainer',
  'opinion',
  'howto',
  'research',
  'interview',
] as const;

export type ArticleType = (typeof ARTICLE_TYPES)[number];
export type ArticleTypeChoice = ArticleType | 'infer';

export const ARTICLE_TYPE_CHOICES: readonly ArticleTypeChoice[] = [
  'infer',
  ...ARTICLE_TYPES,
];
export const DEFAULT_ARTICLE_TYPE_CHOICE: ArticleTypeChoice = 'infer';
/** Used when inference returns nothing usable and the page gives no hint. */
export const FALLBACK_ARTICLE_TYPE: ArticleType = 'news';

/** How a brief's type was settled: picked by the listener, by the model, or neither. */
export type ArticleTypeSource = 'chosen' | 'inferred' | 'fallback';

export interface ResolvedArticleType {
  type: ArticleType;
  source: ArticleTypeSource;
}

export interface ArticleTypeSpec {
  /** One word for the overlay's meta row. */
  short: string;
  /** Menus and Options. */
  label: string;
  /** When the type fits, for inference and tooltips. */
  cue: string;
  /** What to pull out of the article, and the narration's arc and voice. */
  arc: string;
  /** What a chalkboard's boards show. */
  board: string;
  /** Voice-model persona and pacing. */
  narrator: { role: string; delivery: string };
}

export const ARTICLE_TYPE_SPECS: Record<ArticleType, ArticleTypeSpec> = {
  news: {
    short: 'News',
    label: 'News report',
    cue: 'reports a recent event or development',
    arc: 'Inverted pyramid in a neutral anchor voice: cold open on what happened, then who, when, and where, context, developments, why it matters, and what happens next. Attribute claims to their sources.',
    board:
      'A news board: the event and who is involved, a timeline, before and after, key numbers. Cast the real parties by role. The last board is what happens next.',
    narrator: {
      role: 'a calm, clear broadcast news anchor',
      delivery: 'steady pacing and a professional news tone',
    },
  },
  feature: {
    short: 'Feature',
    label: 'Feature story',
    cue: 'tells a story through scenes and people: a narrative feature or profile',
    arc: 'Storytelling voice: open on a scene or a person, bring in the people and what is at stake, follow the arc through its turn to where things stand, and close on a telling detail or quote.',
    board:
      'A storyboard: each board is one scene from the story, in story order, with the real people as the cast.',
    narrator: {
      role: 'a warm, engaging storyteller',
      delivery: 'an unhurried storytelling pace that lets scenes and quotes land',
    },
  },
  explainer: {
    short: 'Explainer',
    label: 'Explainer',
    cue: 'explains how or why something works: a concept, background, or reference piece',
    arc: 'Teach it like a gifted teacher: hook with the question the piece answers and say what we will learn, give the key idea in plain words, build how it works step by step with the example or analogy the piece offers, flag common misconceptions, then close with a short recap.',
    board:
      'Build the concept board by board with visual metaphors, a misconception board with check and cross, and a recap board.',
    narrator: {
      role: 'a warm, clear teacher',
      delivery: 'an engaged, unhurried teaching pace with natural emphasis on key terms',
    },
  },
  opinion: {
    short: 'Opinion',
    label: 'Opinion & analysis',
    cue: 'argues a position: an op-ed, column, editorial, review, or analysis',
    arc: 'Attribute throughout: this is the author\'s view, not settled fact ("the author argues", "in her view"). Lay out the thesis, each main argument with the evidence offered for it, the counterpoints the author raises or rebuts, and the conclusion. Stay neutral; never adopt, judge, or extend the argument.',
    board:
      "Claim, evidence, rebuttal: the author's thesis on the first board, each argument as a pillar holding it up, the objection beside the author's reply, then the conclusion. Cast the author and the sides they argue about.",
    narrator: {
      role: 'a measured, even-handed commentator',
      delivery: 'a calm, neutral tone that presents the argument without endorsing it',
    },
  },
  howto: {
    short: 'How-to',
    label: 'How-to guide',
    cue: 'walks through a task: a tutorial, guide, recipe, or instructions',
    arc: "Coach the listener through it: what they'll get done and what they need first, then the steps in order with commands, settings, or quantities named exactly, the pitfalls, and how to tell it worked. Name code; don't read it out.",
    board:
      "One numbered board per step or small group of steps, with pitfalls as don'ts (cross) beside the dos (check), ending on a checklist of the steps.",
    narrator: {
      role: 'a patient, clear instructor',
      delivery: 'a steady pace with a short pause between steps',
    },
  },
  research: {
    short: 'Research',
    label: 'Research & science',
    cue: 'reports a study, paper, dataset, or scientific finding',
    arc: 'Lead with the finding in plain words, then who did it and how (method, sample, data), the caveats and limits (early results, correlation versus cause, sample size), and why it matters. Never claim more than the evidence supports.',
    board:
      'The question, the setup (who or what was studied and how), the result as a simple chart or before and after, a caveats board, then why it matters.',
    narrator: {
      role: 'a curious, precise science correspondent',
      delivery: 'a clear, measured pace that keeps numbers and caveats distinct',
    },
  },
  interview: {
    short: 'Interview',
    label: 'Interview',
    cue: "is mostly one person's own words: a Q&A or interview",
    arc: 'Say who they are and why they are worth hearing, then the key themes, each anchored by their own words as attributed quotes, and close on a memorable line of theirs. Keep the questions only where the answers need them.',
    board:
      'The subject is the star: who they are first, then one board per theme with them saying a short line in a speech bubble, ending on their closing thought.',
    narrator: {
      role: 'a thoughtful radio host presenting an interview',
      delivery: 'a conversational pace that lets quoted lines sound like the speaker',
    },
  },
};

const TYPE_IDS: ReadonlySet<string> = new Set(ARTICLE_TYPES);

/** Model and provider spellings that aren't our ids but mean one. */
const TYPE_ALIASES: Record<string, ArticleType> = {
  'news report': 'news',
  narrative: 'feature',
  profile: 'feature',
  'feature story': 'feature',
  explanation: 'explainer',
  analysis: 'opinion',
  'op-ed': 'opinion',
  editorial: 'opinion',
  column: 'opinion',
  review: 'opinion',
  'how-to': 'howto',
  'how to': 'howto',
  how_to: 'howto',
  guide: 'howto',
  tutorial: 'howto',
  science: 'research',
  study: 'research',
  'q&a': 'interview',
};

/** A known article type from model output, or null. */
export function parseArticleType(value: unknown): ArticleType | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (TYPE_IDS.has(key)) return key as ArticleType;
  return TYPE_ALIASES[key] ?? null;
}

/** Stored settings value; anything unrecognized goes back to Infer. */
export function coerceArticleTypeChoice(value: unknown): ArticleTypeChoice {
  if (value === 'infer') return 'infer';
  return typeof value === 'string' && TYPE_IDS.has(value)
    ? (value as ArticleType)
    : DEFAULT_ARTICLE_TYPE_CHOICE;
}

/** The `articleType` field of a model's JSON reply, unvalidated. */
export function readArticleTypeField(content: string): unknown {
  try {
    const raw: unknown = JSON.parse(content);
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).articleType
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The listener's pick wins; otherwise the model's answer if it's a known type,
 * else the strongest page hint, else news.
 */
export function resolveArticleType(
  choice: ArticleTypeChoice,
  modelValue: unknown,
  hints: readonly ArticleHint[],
): ResolvedArticleType {
  if (choice !== 'infer') return { type: choice, source: 'chosen' };
  const inferred = parseArticleType(modelValue);
  if (inferred) return { type: inferred, source: 'inferred' };
  return {
    type: hintedArticleType(hints) ?? FALLBACK_ARTICLE_TYPE,
    source: 'fallback',
  };
}

// ── Prompt fragments ──────────────────────────────────────────────────────

function typeGuidance(type: ArticleType, format: SessionFormat): string {
  const spec = ARTICLE_TYPE_SPECS[type];
  return format === 'chalkboard' ? `${spec.arc} Boards: ${spec.board}` : spec.arc;
}

/**
 * System-prompt block for the article type. A listener's pick carries only
 * that type's guidance; Infer carries a one-line cue and the guidance for
 * every type, since the model picks and writes in the same request.
 */
export function articleTypeGuidance(
  choice: ArticleTypeChoice,
  format: SessionFormat,
): string {
  if (choice !== 'infer') {
    return `ARTICLE TYPE: ${ARTICLE_TYPE_SPECS[choice].label}, chosen by the listener. Shape everything this way even if the page reads otherwise.
${typeGuidance(choice, format)}`;
  }
  const rows = ARTICLE_TYPES.map(
    (type) =>
      `- ${type}: ${ARTICLE_TYPE_SPECS[type].cue}. ${typeGuidance(type, format)}`,
  );
  return `ARTICLE TYPE
First decide which type the article is from its text, and put its id in "articleType". Then shape everything the way that type calls for. If it mixes types, pick the one that serves a listener best.
${rows.join('\n')}`;
}

const ARTICLE_TYPE_PROPERTY = {
  type: 'string',
  enum: [...ARTICLE_TYPES],
  description: 'Id of the article type; decide it before writing anything else.',
} as const;

type ObjectSchema = Record<string, unknown> & {
  properties: Record<string, unknown>;
  required: readonly string[];
};

/** With Infer, the reply leads with the chosen `articleType`. */
export function withArticleTypeField(
  schema: ObjectSchema,
  choice: ArticleTypeChoice,
): Record<string, unknown> {
  if (choice !== 'infer') return schema;
  return {
    ...schema,
    properties: { articleType: ARTICLE_TYPE_PROPERTY, ...schema.properties },
    required: ['articleType', ...schema.required],
  };
}

// ── Local page hints ──────────────────────────────────────────────────────

/** Page metadata the content script reads next to the article text. */
export interface PageSignals {
  /** schema.org `@type` values from the page's JSON-LD. */
  schemaTypes: string[];
  /** `articleSection` (JSON-LD) and `article:section` (meta) values. */
  sections: string[];
}

export interface ArticleHint {
  type: ArticleType;
  /** Where it came from, as the model is told. */
  evidence: string;
  weight: number;
}

const MAX_SIGNALS = 8;
const MAX_SIGNAL_CHARS = 60;
const MAX_HINTS = 6;

const SCHEMA_TYPE_HINTS: Record<string, { type: ArticleType; weight: number }> = {
  reportagenewsarticle: { type: 'news', weight: 2 },
  opinionnewsarticle: { type: 'opinion', weight: 3 },
  analysisnewsarticle: { type: 'opinion', weight: 2 },
  reviewnewsarticle: { type: 'opinion', weight: 3 },
  review: { type: 'opinion', weight: 2 },
  backgroundnewsarticle: { type: 'explainer', weight: 2 },
  howto: { type: 'howto', weight: 3 },
  recipe: { type: 'howto', weight: 3 },
  techarticle: { type: 'howto', weight: 1 },
  scholarlyarticle: { type: 'research', weight: 3 },
  medicalscholarlyarticle: { type: 'research', weight: 3 },
};

/** Section names and URL path segments. */
const SECTION_HINTS: Record<string, ArticleType> = {
  news: 'news',
  world: 'news',
  politics: 'news',
  business: 'news',
  breaking: 'news',
  features: 'feature',
  feature: 'feature',
  longreads: 'feature',
  longread: 'feature',
  magazine: 'feature',
  explainers: 'explainer',
  explainer: 'explainer',
  explained: 'explainer',
  opinion: 'opinion',
  opinions: 'opinion',
  'op-ed': 'opinion',
  oped: 'opinion',
  editorial: 'opinion',
  editorials: 'opinion',
  column: 'opinion',
  columns: 'opinion',
  columnists: 'opinion',
  commentary: 'opinion',
  commentisfree: 'opinion',
  ideas: 'opinion',
  reviews: 'opinion',
  analysis: 'opinion',
  'how-to': 'howto',
  howto: 'howto',
  guides: 'howto',
  guide: 'howto',
  tutorials: 'howto',
  tutorial: 'howto',
  recipes: 'howto',
  research: 'research',
  science: 'research',
  studies: 'research',
  interviews: 'interview',
  interview: 'interview',
  'q-and-a': 'interview',
  qa: 'interview',
};

const SLUG_HINTS: [RegExp, ArticleType][] = [
  [/^how-to-/, 'howto'],
  [/(^|-)explained$|^what-(is|are)-/, 'explainer'],
  [/^(opinion|op-ed|editorial)-/, 'opinion'],
  [/^(q-and-a|qa|interview)-/, 'interview'],
];

const HEADLINE_HINTS: [RegExp, ArticleType][] = [
  [/^(opinion|op-ed|editorial|analysis|review)\s*[:|]/i, 'opinion'],
  [/^how to\b/i, 'howto'],
  [/^(explainer|explained)\s*[:|]|\bexplained\b|^what (is|are)\b/i, 'explainer'],
  [/^(q&a|interview)\s*[:|]|\bin conversation with\b/i, 'interview'],
  [/\b(study|researchers|scientists)\s+(find|finds|found|show|shows|suggest|suggests)\b/i, 'research'],
];

const RESEARCH_HOSTS = /(^|\.)(arxiv\.org|biorxiv\.org|medrxiv\.org|pubmed\.ncbi\.nlm\.nih\.gov|doi\.org)$/;

function clipSignal(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNAL_CHARS);
}

function addSignal(list: string[], value: unknown): void {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const clean = clipSignal(item);
    if (clean && !list.includes(clean) && list.length < MAX_SIGNALS) list.push(clean);
  }
}

/** schema.org types and sections from the text of a page's JSON-LD blocks. */
export function pageSignalsFromJsonLd(
  blocks: readonly string[],
  metaSections: readonly string[] = [],
): PageSignals {
  const signals: PageSignals = { schemaTypes: [], sections: [] };
  const visit = (node: unknown, depth: number): void => {
    if (depth > 3 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    addSignal(signals.schemaTypes, record['@type']);
    addSignal(signals.sections, record.articleSection);
    visit(record['@graph'], depth + 1);
  };
  for (const block of blocks) {
    try {
      visit(JSON.parse(block), 0);
    } catch {
      // Malformed JSON-LD is common; the page text still decides.
    }
  }
  addSignal(signals.sections, [...metaSections]);
  return signals;
}

function sectionHint(text: string): ArticleType | null {
  for (const word of text.toLowerCase().split(/[^a-z-]+/)) {
    const type = SECTION_HINTS[word];
    if (type) return type;
  }
  return null;
}

/**
 * Cheap hints from page metadata, the URL, and the headline. They are shown
 * to the model as hints and back the fallback; they never decide alone.
 */
export function articleHints(article: ExtractedArticle): ArticleHint[] {
  const hints: ArticleHint[] = [];

  for (const raw of article.signals?.schemaTypes ?? []) {
    const name = raw.replace(/^https?:\/\/schema\.org\//i, '');
    const match = SCHEMA_TYPE_HINTS[name.toLowerCase()];
    if (match) hints.push({ ...match, evidence: `schema.org ${name}` });
  }

  for (const section of article.signals?.sections ?? []) {
    const type = sectionHint(section);
    if (type) hints.push({ type, evidence: `section "${section}"`, weight: 2 });
  }

  let url: URL | null = null;
  try {
    url = new URL(article.url);
  } catch {
    url = null;
  }
  if (url) {
    if (RESEARCH_HOSTS.test(url.hostname)) {
      hints.push({ type: 'research', evidence: `site ${url.hostname}`, weight: 2 });
    }
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    const slug = segments.pop() ?? '';
    for (const segment of segments) {
      const type = SECTION_HINTS[segment];
      if (type) hints.push({ type, evidence: `URL /${segment}/`, weight: 2 });
    }
    const slugMatch = SLUG_HINTS.find(([pattern]) => pattern.test(slug));
    if (slugMatch) hints.push({ type: slugMatch[1], evidence: 'URL slug', weight: 1 });
  }

  const headlineMatch = HEADLINE_HINTS.find(([pattern]) =>
    pattern.test(article.title.trim()),
  );
  if (headlineMatch) {
    hints.push({ type: headlineMatch[1], evidence: 'headline', weight: 1 });
  }

  return hints.slice(0, MAX_HINTS);
}

/** The type with the most hint weight; ties go to the earlier hint. */
export function hintedArticleType(hints: readonly ArticleHint[]): ArticleType | null {
  const totals = new Map<ArticleType, number>();
  for (const hint of hints) {
    totals.set(hint.type, (totals.get(hint.type) ?? 0) + hint.weight);
  }
  let best: ArticleType | null = null;
  let bestWeight = 0;
  for (const [type, weight] of totals) {
    if (weight > bestWeight) {
      best = type;
      bestWeight = weight;
    }
  }
  return best;
}

/** User-prompt line for Infer, or null when the page gives no hints. */
export function articleHintLine(hints: readonly ArticleHint[]): string | null {
  if (hints.length === 0) return null;
  const byType = new Map<ArticleType, string[]>();
  for (const hint of hints) {
    const evidence = byType.get(hint.type) ?? [];
    if (!evidence.includes(hint.evidence)) evidence.push(hint.evidence);
    byType.set(hint.type, evidence);
  }
  const parts = [...byType].map(
    ([type, evidence]) => `${type} (${evidence.join('; ')})`,
  );
  return `Page hints (weaker than the text itself): ${parts.join(', ')}`;
}

// ── Overlay picker ────────────────────────────────────────────────────────

/**
 * What the next brief on this page uses: the listener's pick in the overlay,
 * else the type the brief on screen was chosen as, else the Options default.
 */
export function effectiveArticleTypeChoice(
  override: ArticleTypeChoice | null,
  current: ResolvedArticleType | null,
  defaultChoice: ArticleTypeChoice | undefined,
): ArticleTypeChoice {
  if (override) return override;
  if (current?.source === 'chosen') return current.type;
  return defaultChoice ?? DEFAULT_ARTICLE_TYPE_CHOICE;
}

/** Meta-row label: the choice, plus what Infer settled on for the brief on screen. */
export function articleTypeLabel(
  choice: ArticleTypeChoice,
  current: ResolvedArticleType | null,
): string {
  if (choice !== 'infer') return ARTICLE_TYPE_SPECS[choice].short;
  return current && current.source !== 'chosen'
    ? `Infer · ${ARTICLE_TYPE_SPECS[current.type].short}`
    : 'Infer';
}

/** What a managed re-brief costs, by the server's own credit rule. */
export function rebriefCreditsLabel(
  kind: SessionKind,
  reportLength: ReportLength,
): string {
  const credits = creditsForSession(kind, reportLength);
  return `${credits} ${credits === 1 ? 'credit' : 'credits'}`;
}

/** Whether briefing again with `choice` could come out as a different type. */
export function choiceChangesType(
  choice: ArticleTypeChoice,
  current: ResolvedArticleType | null,
): boolean {
  if (!current) return false;
  if (choice === 'infer') return current.source === 'chosen';
  return choice !== current.type;
}
