import {
  authApiRoot,
  authRequestHeaders,
  modelForAuth,
  type LlmAuth,
} from './auth';
import {
  emptyUsage,
  fillUsageCost,
  mergeStreamUsage,
  parseProviderUsage,
  type ProviderUsage,
} from './usage';

export class OpenAIError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      error?: { message?: string };
    };
    return data.error?.message || response.statusText || 'OpenAI request failed';
  } catch {
    return response.statusText || 'OpenAI request failed';
  }
}

/**
 * Responses API with structured JSON output (preferred for GPT-5.6+).
 */
export async function createStructuredResponse(options: {
  auth: LlmAuth;
  model: string;
  system: string;
  user: string;
  jsonSchema: {
    name: string;
    schema: Record<string, unknown>;
  };
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}): Promise<{ text: string; usage: ProviderUsage }> {
  const response = await fetch(`${authApiRoot(options.auth)}/responses`, {
    method: 'POST',
    headers: {
      ...authRequestHeaders(options.auth),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelForAuth(options.auth, options.model),
      input: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ],
      reasoning: {
        effort: options.reasoningEffort ?? 'medium',
      },
      text: {
        format: {
          type: 'json_schema',
          name: options.jsonSchema.name,
          strict: true,
          schema: options.jsonSchema.schema,
        },
      },
      ...(options.auth.mode === 'openrouter'
        ? {
            provider: {
              zdr: true,
              data_collection: 'deny',
            },
          }
        : {}),
    }),
  });

  if (!response.ok) {
    throw new OpenAIError(await readErrorMessage(response), response.status);
  }

  const data: unknown = await response.json();
  const usage = await fillUsageCost(options.auth, parseProviderUsage(data));
  const text = readOutputText(data);
  if (!text) {
    throw new OpenAIError('Empty response from comprehension model');
  }
  return { text, usage };
}

function readOutputText(data: unknown): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text;
  }
  if (!Array.isArray(record.output)) return null;
  for (const item of record.output) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (row.type !== 'message' || !Array.isArray(row.content)) continue;
    for (const part of row.content) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) {
        continue;
      }
      const piece = part as Record<string, unknown>;
      if (
        piece.type === 'output_text' &&
        typeof piece.text === 'string' &&
        piece.text.trim()
      ) {
        return piece.text;
      }
    }
  }
  return null;
}

/** OpenAI PCM16: 24 kHz, 16-bit signed LE, mono */
export const PCM_SAMPLE_RATE = 24_000;
export const PCM_BYTES_PER_SAMPLE = 2;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Stream PCM16 audio from gpt-audio-mini (Chat Completions, SSE).
 */
export async function* streamAudioChatPcm(options: {
  auth: LlmAuth;
  model: string;
  voice: string;
  input: string;
  instructions: string;
  signal?: AbortSignal;
  onUsage?: (usage: ProviderUsage) => void | Promise<void>;
}): AsyncGenerator<Uint8Array, void, unknown> {
  const response = await fetch(
    `${authApiRoot(options.auth)}/chat/completions`,
    {
      method: 'POST',
      headers: {
        ...authRequestHeaders(options.auth),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: modelForAuth(options.auth, options.model),
        modalities: ['text', 'audio'],
        audio: {
          voice: options.voice,
          format: 'pcm16',
        },
        stream: true,
        // OpenAI native still needs this; OpenRouter ignores it and always sends usage.
        stream_options: { include_usage: true },
        ...(options.auth.mode === 'openrouter'
          ? {
              provider: {
                zdr: true,
                data_collection: 'deny',
              },
            }
          : {}),
        messages: [
          {
            role: 'system',
            content: options.instructions,
          },
          {
            role: 'user',
            content: options.input,
          },
        ],
      }),
      signal: options.signal,
    },
  );

  if (!response.ok) {
    throw new OpenAIError(await readErrorMessage(response), response.status);
  }

  if (!response.body) {
    throw new OpenAIError('Audio chat API returned no response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = emptyUsage();
  let streamError: unknown;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let event: {
          error?: { message?: string };
          choices?: Array<{
            delta?: {
              audio?: { data?: string };
            };
          }>;
        };
        try {
          event = JSON.parse(payload) as typeof event;
        } catch {
          continue;
        }

        usage = mergeStreamUsage(usage, event);

        if (event.error?.message) {
          throw new OpenAIError(event.error.message);
        }

        const audioB64 = event.choices?.[0]?.delta?.audio?.data;
        if (audioB64) {
          yield base64ToBytes(audioB64);
        }
      }
    }
  } catch (error) {
    streamError = error;
  } finally {
    reader.releaseLock();
  }

  const hasUsage =
    usage.costKnown ||
    Boolean(usage.generationId) ||
    usage.inputTokens !== undefined;
  if (options.onUsage && hasUsage) {
    try {
      await options.onUsage(await fillUsageCost(options.auth, usage));
    } catch {
      // Spend records must not break playback.
    }
  }

  if (streamError) {
    throw streamError;
  }
}
