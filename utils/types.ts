import type { OutputLanguage } from './languages';
import {
  coerceOutputLanguage,
  DEFAULT_OUTPUT_LANGUAGE,
} from './languages';

import {
  DEFAULT_COMPREHENSION_MODEL,
  DEFAULT_DRAWING_MODEL,
  DEFAULT_TTS_MODEL,
} from './models';
import type {
  ChalkLesson,
  ChalkSceneDrawing,
  SessionFormat,
} from './chalk/types';

export type ReportLength = 'short' | 'standard' | 'deep';
export type ProviderMode = 'managed' | 'byok';

/** Voices supported by OpenAI Chat Completions audio models. */
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
  /** Managed Autovox credits or user-funded provider credentials. */
  providerMode: ProviderMode;
  /** Direct OpenAI API key fallback (sk-…). */
  apiKey: string;
  /** OpenRouter API key from OAuth Connect (preferred when set). */
  openRouterApiKey: string;
  voice: VoiceId;
  reportLength: ReportLength;
  /** Target language for the news report and narration. */
  outputLanguage: OutputLanguage;
  /** BYOK comprehension model id (managed listening ignores it). */
  comprehensionModel: string;
  /** BYOK chalkboard drawing model id; empty uses the comprehension model. */
  drawingModel: string;
  /** BYOK narration model id (managed listening ignores it). */
  ttsModel: string;
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
  /** Words in the extracted article, once extraction finishes. */
  sourceWords?: number;
}

/** The script as the writing model streams it; sent to the overlay, never stored. */
export interface BriefDraft {
  /** Spoken text written so far, as one line. */
  text: string;
  words: number;
  /** About how many words the finished script will have. */
  targetWords: number;
}

/** Script + source only — audio is streamed live in the page overlay */
export interface BriefResult {
  source: {
    title: string;
    url: string;
    siteName: string | null;
  };
  script: NewsReportScript;
  /** Absent on briefs saved before chalkboard sessions existed. */
  format?: SessionFormat;
  /** Chalkboard only; `script` is derived from it for the shared player. */
  lesson?: ChalkLesson;
  /** Chalkboard only, by scene; null until that scene's drawing arrives. */
  drawings?: (ChalkSceneDrawing | null)[];
  /** Immutable pricing dimension for managed replay. */
  reportLength?: ReportLength;
  /** The script's language ("auto" resolved from the page when detectable); narration reads in it. */
  outputLanguage?: OutputLanguage;
  /** Local spend session — no page content is attached to the ledger. */
  moneySessionId?: string;
  /** Server-side funded session. The short-lived key is never persisted here. */
  managedSessionId?: string;
}

export type ManagedLifecycleEvent =
  | { type: 'script_ready'; estimatedSeconds: number }
  | { type: 'playback_started' }
  | { type: 'completed'; playbackSeconds: number }
  | {
      type: 'fault';
      stage: 'extract' | 'understand' | 'tts' | 'none';
      playbackSeconds: number;
    }
  | { type: 'aborted'; playbackSeconds: number };

export type ExtensionMessage =
  | { type: 'PING' }
  | { type: 'EXTRACT_ARTICLE' }
  | { type: 'TOGGLE_UI' }
  | { type: 'OPEN_UI' }
  | { type: 'CLOSE_UI' }
  | { type: 'OPEN_OPTIONS' }
  | { type: 'GET_MANAGED_ACCOUNT' }
  | { type: 'ENSURE_MANAGED_ACCOUNT' }
  | { type: 'START_MANAGED_CHECKOUT' }
  | {
      type: 'GET_MANAGED_AUTH';
      sessionId: string;
      estimatedSeconds: number;
      reportLength: ReportLength;
      voice: VoiceId;
      outputLanguage: OutputLanguage;
    }
  | {
      type: 'MANAGED_LIFECYCLE';
      sessionId: string;
      event: ManagedLifecycleEvent;
    }
  | { type: 'START_BRIEF'; tabId?: number; format?: SessionFormat }
  /** Brief state for the sender's tab + page URL only. */
  | { type: 'GET_BRIEF_STATE' }
  /** Clears brief state for the sender's tab only. */
  | { type: 'CLEAR_BRIEF' }
  /** Tab navigated — overlay should drop local brief UI. */
  | { type: 'BRIEF_RESET' }
  /** Targeted at the owning tab via tabs.sendMessage (not broadcast). */
  | { type: 'BRIEF_PROGRESS'; progress: BriefProgress }
  /** Live draft of the script while it's being written (owning tab only). */
  | { type: 'BRIEF_DRAFT'; pageUrl: string; draft: BriefDraft }
  | { type: 'BRIEF_SCRIPT_READY'; result: BriefResult }
  /** One chalkboard scene finished drawing (targeted at the owning tab). */
  | {
      type: 'CHALK_SCENE_READY';
      pageUrl: string;
      /** The owning brief's `moneySessionId`, so stale scenes are ignored. */
      sessionId: string;
      scene: number;
      drawing: ChalkSceneDrawing;
    }
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
  providerMode: 'byok',
  apiKey: '',
  openRouterApiKey: '',
  voice: 'sage',
  reportLength: 'standard',
  outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
  comprehensionModel: DEFAULT_COMPREHENSION_MODEL,
  drawingModel: DEFAULT_DRAWING_MODEL,
  ttsModel: DEFAULT_TTS_MODEL,
};

const VOICE_IDS = new Set<string>(VOICES.map((v) => v.id));

export function coerceVoice(value: unknown): VoiceId {
  if (typeof value === 'string' && VOICE_IDS.has(value)) {
    return value as VoiceId;
  }
  return DEFAULT_SETTINGS.voice;
}
