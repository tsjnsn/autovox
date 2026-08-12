import type { OutputLanguage } from './languages';
import {
  coerceOutputLanguage,
  DEFAULT_OUTPUT_LANGUAGE,
} from './languages';

export type { OutputLanguage };
export {
  coerceOutputLanguage,
  DEFAULT_OUTPUT_LANGUAGE,
  OUTPUT_LANGUAGES,
} from './languages';

export type ReportLength = 'short' | 'standard' | 'deep';

/** Voices supported by gpt-audio-mini (Chat Completions audio). */
export type VoiceId =
  | 'alloy'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'echo'
  | 'fable'
  | 'nova'
  | 'onyx'
  | 'sage'
  | 'shimmer'
  | 'verse';

export interface Settings {
  /** Direct OpenAI API key fallback (sk-…). */
  apiKey: string;
  /** OpenRouter API key from OAuth Connect (preferred when set). */
  openRouterApiKey: string;
  voice: VoiceId;
  reportLength: ReportLength;
  /** Target language for the news report and narration. */
  outputLanguage: OutputLanguage;
}

export interface ExtractedArticle {
  title: string;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
  url: string;
  textContent: string;
  length: number;
}

export interface NewsReportScript {
  headline: string;
  lede: string;
  segments: string[];
  estimatedSeconds: number;
}

export type BriefPhase =
  | 'idle'
  | 'extracting'
  | 'understanding'
  | 'writing'
  | 'generating_audio'
  | 'ready'
  | 'error';

export interface BriefProgress {
  phase: BriefPhase;
  message: string;
  detail?: string;
}

/** Script + source only — audio is streamed live in the page overlay */
export interface BriefResult {
  source: {
    title: string;
    url: string;
    siteName: string | null;
  };
  script: NewsReportScript;
}

export type ExtensionMessage =
  | { type: 'PING' }
  | { type: 'EXTRACT_ARTICLE' }
  | { type: 'TOGGLE_UI' }
  | { type: 'CLOSE_UI' }
  | { type: 'OPEN_OPTIONS' }
  | { type: 'START_BRIEF'; tabId?: number }
  /** Brief state for the sender's tab + page URL only. */
  | { type: 'GET_BRIEF_STATE' }
  /** Clears brief state for the sender's tab only. */
  | { type: 'CLEAR_BRIEF' }
  /** Tab navigated — overlay should drop local brief UI. */
  | { type: 'BRIEF_RESET' }
  /** Targeted at the owning tab via tabs.sendMessage (not broadcast). */
  | { type: 'BRIEF_PROGRESS'; progress: BriefProgress }
  | { type: 'BRIEF_SCRIPT_READY'; result: BriefResult }
  | { type: 'BRIEF_ERROR'; error: string };

export const VOICES: { id: VoiceId; label: string }[] = [
  { id: 'sage', label: 'Sage' },
  { id: 'alloy', label: 'Alloy' },
  { id: 'ash', label: 'Ash' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'coral', label: 'Coral' },
  { id: 'echo', label: 'Echo' },
  { id: 'fable', label: 'Fable' },
  { id: 'nova', label: 'Nova' },
  { id: 'onyx', label: 'Onyx' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'verse', label: 'Verse' },
];

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  openRouterApiKey: '',
  voice: 'sage',
  reportLength: 'standard',
  outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
};

const VOICE_IDS = new Set<string>(VOICES.map((v) => v.id));

export function coerceVoice(value: unknown): VoiceId {
  if (typeof value === 'string' && VOICE_IDS.has(value)) {
    return value as VoiceId;
  }
  return DEFAULT_SETTINGS.voice;
}
