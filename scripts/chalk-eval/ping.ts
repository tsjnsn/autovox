/**
 * Sends each model one tiny request with the eval's routing preferences, then
 * reads OpenRouter's generation record for the host, timings, tokens, and cost.
 *
 *   pnpm exec tsx scripts/chalk-eval/ping.ts [model,model,…]
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_MODELS = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5',
  'openai/gpt-6-sol',
  'openai/gpt-6-luna',
  'google/gemini-3.8-flash',
  'z-ai/glm-5.3',
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4.1-flash',
  'xiaomi/mimo-v2.6-pro',
];
const TIMEOUT_MS = 90_000;

interface Generation {
  provider_name?: string;
  latency?: number;
  generation_time?: number;
  tokens_prompt?: number;
  tokens_completion?: number;
  native_tokens_reasoning?: number;
  total_cost?: number;
}

async function generation(apiKey: string, id: string): Promise<Generation | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 1000 + attempt * 1000));
    const response = await fetch(
      `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (response.ok) {
      const body = (await response.json()) as { data?: Generation };
      if (body.data) return body.data;
    }
  }
  return null;
}

async function ping(apiKey: string, model: string): Promise<string> {
  const start = performance.now();
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Autovox eval ping',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        provider: { data_collection: 'deny' },
      }),
    });
    const wall = (performance.now() - start) / 1000;
    const body = (await response.json().catch(() => null)) as {
      id?: string;
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      return `FAIL ${response.status} after ${wall.toFixed(1)}s: ${body?.error?.message ?? ''}`;
    }
    const reply = (body?.choices?.[0]?.message?.content ?? '').trim().slice(0, 20);
    const gen = body?.id ? await generation(apiKey, body.id) : null;
    const ttft = gen?.latency !== undefined ? `${(gen.latency / 1000).toFixed(1)}s` : '?';
    const genTime = gen?.generation_time !== undefined ? `${(gen.generation_time / 1000).toFixed(1)}s` : '?';
    return [
      `wall ${wall.toFixed(1)}s`,
      `first token ${ttft}`,
      `generating ${genTime}`,
      `host ${gen?.provider_name ?? '?'}`,
      `tokens ${gen?.tokens_prompt ?? '?'} in / ${gen?.tokens_completion ?? '?'} out (${gen?.native_tokens_reasoning ?? 0} reasoning)`,
      `cost $${(gen?.total_cost ?? 0).toFixed(6)}`,
      `reply "${reply}"`,
    ].join(' · ');
  } catch (error) {
    const wall = (performance.now() - start) / 1000;
    return `FAIL after ${wall.toFixed(1)}s: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function main(): Promise<void> {
  const envFile = resolve(ROOT, '.env');
  if (!process.env.OPENROUTER_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY (environment or .env).');
  const models = process.argv[2]?.split(',').filter(Boolean) ?? DEFAULT_MODELS;
  for (const model of models) {
    console.log(`${model.padEnd(30)} ${await ping(apiKey, model)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
