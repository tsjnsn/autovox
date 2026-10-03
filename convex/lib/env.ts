import { managedError } from "./errors";

const NOT_CONFIGURED_MESSAGE =
  "Managed listening isn't fully set up on the server yet. Try again later.";

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not configured`);
    throw managedError("not_configured", NOT_CONFIGURED_MESSAGE);
  }
  return value;
}

export function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`${name} must be a positive integer`);
    throw managedError("not_configured", NOT_CONFIGURED_MESSAGE);
  }
  return parsed;
}
