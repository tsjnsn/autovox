import {
  authApiRoot,
  authRequestHeaders,
  modelForAuth,
  openRouterProviderPrefs,
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

/** Errors inside an accepted stream carry a provider code instead of an HTTP status. */
function streamErrorStatus(code: unknown): number | undefined {
  if (typeof code === 'number') return code;
  if (code === 'rate_limit_exceeded') return 429;
  if (code === 'server_error') return 502;
  return undefined;
}

/** OpenRouter wraps upstream failures as "Provider returned error" with the detail in metadata. */
function upstreamDetail(metadata: unknown): string {
  if (metadata === null || typeof metadata !== 'object') return '';
  const { raw, provider_name: provider } = metadata as {
    raw?: unknown;
    provider_name?: unknown;
  };
  const rawText =
    typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw);
  const detail = rawText.length > 500 ? `${rawText.slice(0, 500)}…` : rawText;
  if (!detail) return '';
  return typeof provider === 'string' ? `${provider}: ${detail}` : detail;
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = response.statusText || 'OpenAI request failed';
  try {
    const data = (await response.json()) as {
      error?: { message?: string; metadata?: unknown };
    };
    const message = data.error?.message || fallback;
    const detail = upstreamDetail(data.error?.metadata);
    return `${message} (${response.status})${detail ? ` — ${detail}` : ''}`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

/** Live counts while a structured response streams. */
export interface StreamProgress {
  reasoningChars: number;
  outputChars: number;
  /** Output text so far (partial JSON for structured calls). */
  text: string;
  /** Time to the first reasoning or output delta. */
  firstTokenMs: number | null;
  elapsedMs: number;
}

/** Rough token count for streamed text (~4 characters per token). */
export const approxTokens = (chars: number) => Math.round(chars / 4);

/**
 * Reads a Responses API event stream: accumulates output text, reports
 * progress on every delta, and returns the final response object.
 */
async function readResponsesStream(
  response: Response,
  onProgress: (progress: StreamProgress) => void,
): Promise<{ text: string; final: unknown }> {
  if (!response.body) throw new OpenAIError('Streaming response had no body');
  const started = Date.now();
  const progress: StreamProgress = {
    reasoningChars: 0,
    outputChars: 0,
    text: '',
    firstTokenMs: null,
    elapsedMs: 0,
  };
  let text = '';
  let final: unknown = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof event.type === 'string' ? event.type : '';
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (type === 'response.output_text.delta' && delta) {
        text += delta;
        progress.outputChars += delta.length;
        progress.text = text;
      } else if (type.includes('reasoning') && type.endsWith('.delta') && delta) {
        progress.reasoningChars += delta.length;
      } else if (
        type === 'response.completed' ||
        type === 'response.incomplete' ||
        type === 'response.failed'
      ) {
        final = event.response ?? null;
      } else if (type === 'error') {
        const error = event.error as { message?: string; code?: unknown } | undefined;
        throw new OpenAIError(
          error?.message ?? 'Stream error',
          streamErrorStatus(error?.code ?? event.code),
        );
      } else {
        continue;
      }
      progress.elapsedMs = Date.now() - started;
      if (progress.firstTokenMs === null && (progress.reasoningChars || progress.outputChars)) {
        progress.firstTokenMs = progress.elapsedMs;
      }
      onProgress({ ...progress });
    }
  }
  return { text, final };
}

/**
 * Responses API with structured JSON output (preferred for GPT-5+ reasoning models).
 * Passing `onProgress` streams the response and reports token progress as it arrives.
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
  /** Caps reasoning plus output so a runaway response fails fast instead of stalling. */
  maxOutputTokens?: number;
  /** OpenRouter host preference; latency-sensitive calls want the fastest host. */
  hostSort?: 'throughput' | 'latency';
  onProgress?: (progress: StreamProgress) => void;
  signal?: AbortSignal;
}): Promise<{ text: string; usage: ProviderUsage }> {
  const streaming = Boolean(options.onProgress);
  const send = (requireParameters: boolean) =>
    fetch(`${authApiRoot(options.auth)}/responses`, {
      method: 'POST',
      headers: {
        ...authRequestHeaders(options.auth),
        'Content-Type': 'application/json',
        ...(streaming ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify({
        ...(streaming ? { stream: true } : {}),
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
        ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
        ...openRouterProviderPrefs(options.auth, {
          requireParameters,
          sort: options.hostSort,
        }),
      }),
      signal: options.signal,
    });

  let response = await send(true);
  // Models without reasoning (e.g. gpt-4.1-mini) have no host that accepts every
  // parameter; OpenRouter answers 404 rather than dropping the unsupported one.
  if (response.status === 404 && options.auth.mode === 'openrouter') {
    await response.body?.cancel();
    response = await send(false);
  }

  if (!response.ok) {
    throw new OpenAIError(await readErrorMessage(response), response.status);
  }

  if (options.onProgress) {
    const { text: streamed, final } = await readResponsesStream(response, options.onProgress);
    const usage = await fillUsageCost(options.auth, parseProviderUsage(final));
    const text = streamed.trim() ? streamed : readOutputText(final);
    if (!text) {
      throw new OpenAIError('Empty response from comprehension model');
    }
    return { text, usage };
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
 * Stream PCM16 audio from a Chat Completions audio model (SSE).
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
        ...openRouterProviderPrefs(options.auth),
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
          error?: { message?: string; code?: unknown };
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
          throw new OpenAIError(
            event.error.message,
            streamErrorStatus(event.error.code),
          );
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
