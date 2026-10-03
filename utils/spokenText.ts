import type { NewsReportScript } from './types';

/** Full spoken script text for display / TTS assembly */
export function scriptToSpokenText(script: NewsReportScript): string {
  return [script.lede, ...script.segments].join('\n\n');
}
