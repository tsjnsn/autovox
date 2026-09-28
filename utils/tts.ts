import type { LlmAuth } from './auth';
import { ttsLanguageInstruction } from './languages';
import { streamAudioChatPcm } from './openai';
import type { ProviderUsage } from './usage';
import type { NewsReportScript, OutputLanguage, VoiceId } from './types';
import { scriptToSpokenText } from './understand';
import { flattenBeats, type ChalkLesson } from './chalk/types';

const MAX_CHARS = 2800;

const NEWS_ANCHOR_BASE = `You are a calm, clear broadcast news anchor.
Read the user's script aloud verbatim — every word, in order.
Do not greet, summarize, paraphrase, add commentary, or skip lines.
Use steady pacing and a professional news tone.
Speak only the script text.`;

const TEACHER_BASE = `You are a warm, clear teacher explaining a lesson at a chalkboard.
Read the user's script aloud verbatim — every word, in order.
Do not greet, summarize, paraphrase, add commentary, or skip lines.
Use an engaged, unhurried teaching pace with natural emphasis on key terms.
Speak only the script text.`;

export function buildNewsAnchorInstructions(
  outputLanguage: OutputLanguage,
): string {
  return `${NEWS_ANCHOR_BASE}\n${ttsLanguageInstruction(outputLanguage)}`;
}

export function buildTeacherInstructions(outputLanguage: OutputLanguage): string {
  return `${TEACHER_BASE}\n${ttsLanguageInstruction(outputLanguage)}`;
}

function chunkText(text: string, maxChars = MAX_CHARS): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      pushCurrent();
      const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [
        paragraph,
      ];
      for (const sentence of sentences) {
        const piece = sentence.trim();
        if (!piece) continue;
        if (piece.length > maxChars) {
          pushCurrent();
          for (let i = 0; i < piece.length; i += maxChars) {
            chunks.push(piece.slice(i, i + maxChars));
          }
          continue;
        }
        const next = current ? `${current} ${piece}` : piece;
        if (next.length > maxChars) {
          pushCurrent();
          current = piece;
        } else {
          current = next;
        }
      }
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars) {
      pushCurrent();
      current = paragraph;
    } else {
      current = next;
    }
  }

  pushCurrent();
  return chunks;
}

export function buildTtsChunks(script: NewsReportScript): string[] {
  const withHeadline = `${script.headline}.\n\n${scriptToSpokenText(script)}`;
  return chunkText(withHeadline);
}

/**
 * One narration request per lesson beat, in board order, so each beat's exact
 * position on the audio timeline is known and the board can follow it. The
 * title is spoken ahead of the first beat while the first heading is written.
 */
export function lessonTtsChunks(lesson: ChalkLesson): string[] {
  const chunks = flattenBeats(lesson).map((beat) => beat.say);
  if (chunks.length > 0) {
    chunks[0] = `${lesson.title}.\n\n${chunks[0]}`;
  }
  return chunks;
}

export function streamSegmentPcm(options: {
  auth: LlmAuth;
  model: string;
  voice: VoiceId;
  text: string;
  outputLanguage: OutputLanguage;
  /** System voice direction; defaults to the news anchor. */
  instructions?: string;
  signal?: AbortSignal;
  onUsage?: (usage: ProviderUsage) => void | Promise<void>;
}): AsyncGenerator<Uint8Array, void, unknown> {
  return streamAudioChatPcm({
    auth: options.auth,
    model: options.model,
    voice: options.voice,
    input: options.text,
    instructions:
      options.instructions ??
      buildNewsAnchorInstructions(options.outputLanguage),
    signal: options.signal,
    onUsage: options.onUsage,
  });
}
