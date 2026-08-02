export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectError';
  }
}

const OPENROUTER_AUTH = 'https://openrouter.ai/auth';
const OPENROUTER_EXCHANGE = 'https://openrouter.ai/api/v1/auth/keys';

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

async function createS256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hash);
}

/**
 * OpenRouter OAuth PKCE via chrome.identity.
 * Returns a user-controlled OpenRouter API key to store locally.
 */
export async function connectOpenRouter(): Promise<string> {
  if (!browser.identity?.launchWebAuthFlow || !browser.identity.getRedirectURL) {
    throw new ConnectError(
      'This browser build does not support identity.launchWebAuthFlow.',
    );
  }

  const callbackUrl = browser.identity.getRedirectURL();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await createS256Challenge(codeVerifier);

  const authorizeUrl = new URL(OPENROUTER_AUTH);
  authorizeUrl.searchParams.set('callback_url', callbackUrl);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const redirectUrl = await browser.identity.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true,
  });

  if (!redirectUrl) {
    throw new ConnectError('Connect was cancelled or failed');
  }

  const result = new URL(redirectUrl);
  const error = result.searchParams.get('error');
  if (error) {
    throw new ConnectError(
      result.searchParams.get('error_description') || error,
    );
  }

  const code = result.searchParams.get('code');
  if (!code) {
    throw new ConnectError('OpenRouter did not return an authorization code');
  }

  const exchange = await fetch(OPENROUTER_EXCHANGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256',
    }),
  });

  if (!exchange.ok) {
    let detail = 'Failed to exchange OpenRouter authorization code';
    try {
      const body = (await exchange.json()) as { error?: string; message?: string };
      detail = body.error || body.message || detail;
    } catch {
      /* ignore */
    }
    throw new ConnectError(detail);
  }

  const payload = (await exchange.json()) as { key?: string };
  if (!payload.key?.trim()) {
    throw new ConnectError('OpenRouter did not return an API key');
  }

  return payload.key.trim();
}
