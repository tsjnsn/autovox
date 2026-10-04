import type { ChalkLesson, ChalkSceneDrawing } from './chalk/types';
import type { NewsReportScript } from './types';

/** A saved brief the player can step to, without the script or the art. */
export interface ArtifactSummary {
  id: string;
  createdAt: number;
  format: 'brief' | 'chalkboard';
  headline: string;
  sourceTitle: string;
  siteName: string | null;
}

/** One saved brief loaded into the player. */
export interface SavedTape {
  id: string;
  createdAt: number;
  format: 'brief' | 'chalkboard';
  headline: string;
  sourceTitle: string;
  siteName: string | null;
  script: NewsReportScript;
  lesson: ChalkLesson | null;
  drawings: (ChalkSceneDrawing | null)[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isScript(value: unknown): value is NewsReportScript {
  if (!isRecord(value)) return false;
  const segments = value.segments;
  return (
    typeof value.headline === 'string' &&
    typeof value.lede === 'string' &&
    typeof value.estimatedSeconds === 'number' &&
    Array.isArray(segments) &&
    segments.every((part) => typeof part === 'string')
  );
}

function summaryFrom(value: unknown): ArtifactSummary | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.headline !== 'string') return null;
  if (value.format !== 'brief' && value.format !== 'chalkboard') return null;
  return {
    id: value.id,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    format: value.format,
    headline: value.headline,
    sourceTitle: typeof value.sourceTitle === 'string' ? value.sourceTitle : '',
    siteName: typeof value.siteName === 'string' ? value.siteName : null,
  };
}

export function readArtifactSummaries(value: unknown): ArtifactSummary[] {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) return [];
  return value.artifacts.flatMap((item) => {
    const summary = summaryFrom(item);
    return summary ? [summary] : [];
  });
}

export function readSavedTape(value: unknown): SavedTape | null {
  if (!isRecord(value) || !isRecord(value.artifact)) return null;
  const artifact = value.artifact;
  const summary = summaryFrom(artifact);
  if (!summary || !isScript(artifact.script)) return null;
  const lesson = isRecord(artifact.lesson) ? (artifact.lesson as unknown as ChalkLesson) : null;
  const drawings = Array.isArray(artifact.drawings)
    ? (artifact.drawings as (ChalkSceneDrawing | null)[])
    : null;
  return { ...summary, script: artifact.script, lesson, drawings };
}
