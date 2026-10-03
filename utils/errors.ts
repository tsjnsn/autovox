import {
  managedErrorData,
  type ManagedErrorCode,
} from '../convex/lib/errors';
import { OpenAIError } from './providerError';

/** What a failed brief means for the listener; the meter label follows from it. */
export type BriefErrorKind =
  | 'setup'
  | 'credits'
  | 'paused'
  | 'transient'
  | 'page'
  | 'fault';

/** A failed runtime message response. */
export interface ErrorResponse {
  ok: false;
  /** Safe to show the user. */
  error: string;
  code?: ManagedErrorCode;
  kind: BriefErrorKind;
}

/** No usable provider credentials; fixed in Options. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

/** The page can't be briefed: no readable text, or Autovox can't run on it. */
export class PageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageError';
  }
}

/** A failure another extension context already classified, relayed with its message. */
export class RelayedError extends Error {
  constructor(
    message: string,
    public kind: BriefErrorKind,
  ) {
    super(message);
    this.name = 'RelayedError';
  }
}

const MANAGED_KINDS: Record<ManagedErrorCode, BriefErrorKind> = {
  not_authenticated: 'setup',
  account_not_initialized: 'setup',
  account_suspended: 'setup',
  not_configured: 'setup',
  no_credits: 'credits',
  paused: 'paused',
  daily_budget_reached: 'paused',
  trial_budget_reached: 'paused',
  session_in_progress: 'transient',
  retry_shortly: 'transient',
  provider_unavailable: 'transient',
  request_reused: 'fault',
  invalid_request: 'fault',
  not_found: 'fault',
  forbidden: 'fault',
  product_unavailable: 'fault',
};

const METER_LABELS: Record<BriefErrorKind, string> = {
  setup: 'Needs setup',
  credits: 'No credits',
  paused: 'Retry',
  transient: 'Retry',
  page: 'Fault',
  fault: 'Fault',
};

function statusKind(status: number | undefined): BriefErrorKind {
  if (status === undefined) return 'fault';
  if (status === 401 || status === 403) return 'setup';
  if (status === 402) return 'credits';
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  return 'fault';
}

export function briefErrorKind(error: unknown): BriefErrorKind {
  const managed = managedErrorData(error);
  if (managed) return MANAGED_KINDS[managed.code];
  if (error instanceof RelayedError) return error.kind;
  if (error instanceof SetupError) return 'setup';
  if (error instanceof PageError) return 'page';
  if (error instanceof OpenAIError) return statusKind(error.status);
  // fetch rejects with a TypeError when the network fails.
  if (error instanceof TypeError) return 'transient';
  return 'fault';
}

/** Short meter label for a failure (DESIGN.md, meter labels). */
export function errorMeterLabel(kind: BriefErrorKind): string {
  return METER_LABELS[kind];
}

/** Managed errors carry a user-safe message; the ConvexError's own message is a server trace. */
export function errorMessage(error: unknown, fallback: string): string {
  const managed = managedErrorData(error);
  if (managed) return managed.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

export function errorResponse(error: unknown, fallback: string): ErrorResponse {
  const code = managedErrorData(error)?.code;
  return {
    ok: false,
    error: errorMessage(error, fallback),
    ...(code ? { code } : {}),
    kind: briefErrorKind(error),
  };
}
