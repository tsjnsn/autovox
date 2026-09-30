import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE } from '../openai';
import { BoardRenderer } from './renderer';
import type { ChalkLesson, ChalkSceneDrawing, ChalkTimeline } from './types';

/** 5:3 like the board, and even on both sides as H.264 requires. */
export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 768;
export const VIDEO_FPS = 30;
/** Narration is 24 kHz; AAC encoders only take 44.1/48 kHz. */
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHUNK_SECONDS = 1;
const YIELD_EVERY_FRAMES = 10;

interface VideoPlan {
  container: 'mp4' | 'webm';
  video: VideoCodec;
  audio: AudioCodec;
}

const PLANS: VideoPlan[] = [
  { container: 'mp4', video: 'avc', audio: 'aac' },
  { container: 'webm', video: 'vp9', audio: 'opus' },
  { container: 'webm', video: 'vp8', audio: 'opus' },
];

export interface ChalkVideoInput {
  lesson: ChalkLesson;
  drawings: (ChalkSceneDrawing | null)[];
  timeline: ChalkTimeline;
  /** The complete narration: 16-bit mono PCM at PCM_SAMPLE_RATE. */
  pcm: Uint8Array;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface ChalkVideo {
  blob: Blob;
  fileName: string;
}

async function pickPlan(): Promise<VideoPlan> {
  for (const plan of PLANS) {
    const [video, audio] = await Promise.all([
      canEncodeVideo(plan.video, {
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        frameRate: VIDEO_FPS,
        quality: QUALITY_HIGH,
      }),
      canEncodeAudio(plan.audio, {
        numberOfChannels: 1,
        sampleRate: AUDIO_SAMPLE_RATE,
        quality: QUALITY_HIGH,
      }),
    ]);
    if (video && audio) return plan;
  }
  throw new Error('This browser cannot encode video');
}

/** Lets the page paint and handle input between batches of frames. */
function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/** A download name from the lesson title, safe on every OS. */
export function videoFileName(title: string, extension: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return `${base || 'Chalkboard'}${extension}`;
}

export function downloadVideo(video: ChalkVideo): void {
  const url = URL.createObjectURL(video.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = video.fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Renders the board frame by frame against the finished narration and muxes
 * both into one file. Runs faster than real time; nothing leaves the browser.
 */
export async function renderChalkVideo(input: ChalkVideoInput): Promise<ChalkVideo> {
  const { lesson, drawings, timeline, pcm, signal, onProgress } = input;
  const bytesPerSecond = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE;
  const pcmBytes = pcm.byteLength - (pcm.byteLength % PCM_BYTES_PER_SAMPLE);
  const duration = pcmBytes / bytesPerSecond;
  if (duration <= 0) throw new Error('No narration to export');

  const plan = await pickPlan();
  signal?.throwIfAborted();

  const canvas = document.createElement('canvas');
  const renderer = new BoardRenderer(canvas, { pixelRatio: 1 });
  renderer.setCssSize(VIDEO_WIDTH, VIDEO_HEIGHT);
  let time = 0;
  const board = { lesson, drawings, timeline, getTime: () => time };

  const output = new Output({
    format:
      plan.container === 'mp4'
        ? new Mp4OutputFormat({ fastStart: 'in-memory' })
        : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const video = new CanvasSource(canvas, { codec: plan.video, quality: QUALITY_HIGH });
  const audio = new AudioSampleSource({
    codec: plan.audio,
    quality: QUALITY_HIGH,
    transform: { sampleRate: AUDIO_SAMPLE_RATE },
  });
  output.addVideoTrack(video, { frameRate: VIDEO_FPS });
  output.addAudioTrack(audio);
  output.setMetadataTags({
    title: lesson.title,
    comment: 'Made with Autovox. Narration is an AI-generated voice.',
  });

  let audioBytes = 0;
  const addAudioThrough = async (seconds: number) => {
    const chunkBytes = bytesPerSecond * AUDIO_CHUNK_SECONDS;
    while (audioBytes < pcmBytes && audioBytes / bytesPerSecond <= seconds) {
      const end = Math.min(pcmBytes, audioBytes + chunkBytes);
      const sample = new AudioSample({
        data: pcm.subarray(audioBytes, end),
        format: 's16',
        numberOfChannels: 1,
        sampleRate: PCM_SAMPLE_RATE,
        timestamp: audioBytes / bytesPerSecond,
      });
      try {
        await audio.add(sample);
      } finally {
        sample.close();
      }
      audioBytes = end;
    }
  };

  const frames = Math.max(1, Math.ceil(duration * VIDEO_FPS));
  try {
    await output.start();
    for (let i = 0; i < frames; i++) {
      signal?.throwIfAborted();
      time = i / VIDEO_FPS;
      await addAudioThrough(time + AUDIO_CHUNK_SECONDS);
      renderer.render(board);
      await video.add(time, 1 / VIDEO_FPS);
      onProgress?.((i + 1) / frames);
      if (i % YIELD_EVERY_FRAMES === YIELD_EVERY_FRAMES - 1) await yieldToPage();
    }
    await addAudioThrough(Infinity);
    video.close();
    audio.close();
    signal?.throwIfAborted();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Video export produced no data');
  return {
    blob: new Blob([buffer], { type: output.format.mimeType }),
    fileName: videoFileName(lesson.title, output.format.fileExtension),
  };
}
