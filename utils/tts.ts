import type { LlmAuth } from './auth';
import { streamAudioChatPcm } from './openai';
import type { NewsReportScript, VoiceId } from './types';
import { scriptToSpokenText } from './understand';

/** Chat Completions audio model for spoken narration */
export const TTS_MODEL = 'gpt-audio-mini';

const MAX_CHARS = 2800;

export const NEWS_ANCHOR_INSTRUCTIONS = `You are a calm, clear broadcast news anchor.
Read the user's script aloud verbatim — every word, in order.
Do not greet, summarize, paraphrase, add commentary, or skip lines.
Use steady pacing and a professional news tone.
Speak only the script text.`;

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

export function streamSegmentPcm(options: {
  auth: LlmAuth;
  voice: VoiceId;
  text: string;
  signal?: AbortSignal;
}): AsyncGenerator<Uint8Array, void, unknown> {
  return streamAudioChatPcm({
    auth: options.auth,
    model: TTS_MODEL,
    voice: options.voice,
    input: options.text,
    instructions: NEWS_ANCHOR_INSTRUCTIONS,
    signal: options.signal,
  });
}
