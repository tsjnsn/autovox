import {
  authApiRoot,
  authRequestHeaders,
  modelForAuth,
  type LlmAuth,
} from './auth';

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
}): Promise<string> {
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
    }),
  });

  if (!response.ok) {
    throw new OpenAIError(await readErrorMessage(response), response.status);
  }

  const data = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  if (data.output_text?.trim()) {
    return data.output_text;
  }

  for (const item of data.output ?? []) {
    if (item.type !== 'message' || !item.content) continue;
    for (const part of item.content) {
      if (part.type === 'output_text' && part.text?.trim()) {
        return part.text;
      }
    }
  }

  throw new OpenAIError('Empty response from comprehension model');
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

        if (event.error?.message) {
          throw new OpenAIError(event.error.message);
        }

        const audioB64 = event.choices?.[0]?.delta?.audio?.data;
        if (audioB64) {
          yield base64ToBytes(audioB64);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
