import { PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE } from './openai';

/** Start playback after buffering this much PCM (~200 ms). */
const START_BUFFER_BYTES = Math.floor(
  PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 0.2,
);

/** Schedule audio in ~120 ms blocks to avoid thousands of source nodes. */
const SCHEDULE_CHUNK_BYTES = Math.floor(
  PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 0.12,
);

export function pcmDurationSeconds(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / PCM_BYTES_PER_SAMPLE);
  return samples / PCM_SAMPLE_RATE;
}

/**
 * Schedules streamed 24 kHz 16-bit LE mono PCM onto a Web Audio graph.
 * Playback begins once the first ~200 ms of samples arrive.
 */
export class PcmStreamPlayer {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private pending: Uint8Array = new Uint8Array(0);
  private coalesce: Uint8Array = new Uint8Array(0);
  private bufferedBeforeStart = 0;
  private started = false;
  private sources = new Set<AudioBufferSourceNode>();
  private gain: GainNode | null = null;
  private volume = 1;
  private _playing = false;
  private _ended = false;
  private streamComplete = false;
  private activeSources = 0;

  /** Media-timeline clock (seconds). */
  private anchorMediaTime = 0;
  private anchorCtxTime = 0;
  private clockRunning = false;
  private startMediaOffset = 0;
  private _duration = 0;

  onStart?: () => void;
  onEnded?: () => void;
  onAutoplayBlocked?: () => void;

  get playing(): boolean {
    return this._playing;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get ended(): boolean {
    return this._ended;
  }

  get duration(): number {
    return this._duration;
  }

  /** Current media time in seconds. */
  getCurrentTime(): number {
    if (this._ended && this._duration > 0) {
      return this._duration;
    }
    if (!this.ctx || !this.clockRunning || this.ctx.state !== 'running') {
      return this.anchorMediaTime;
    }
    const t =
      this.anchorMediaTime + (this.ctx.currentTime - this.anchorCtxTime);
    if (this._duration > 0) {
      return Math.min(this._duration, Math.max(0, t));
    }
    return Math.max(0, t);
  }

  setDuration(seconds: number): void {
    this._duration = Math.max(0, seconds);
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
      this.nextTime = 0;
    }
    return this.ctx;
  }

  private armClock(mediaTime: number): void {
    this.anchorMediaTime = Math.max(0, mediaTime);
    this.anchorCtxTime = this.ctx?.currentTime ?? 0;
    this.clockRunning = true;
  }

  private freezeClock(): void {
    if (this.clockRunning && this.ctx && this.ctx.state === 'running') {
      this.anchorMediaTime = this.getCurrentTime();
    }
    this.clockRunning = false;
  }

  async resume(): Promise<void> {
    if (this._ended) {
      this._playing = false;
      return;
    }
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    this._playing = ctx.state === 'running';
    if (this._playing && this.started) {
      this.armClock(this.anchorMediaTime);
    }
  }

  async suspend(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') {
      this.freezeClock();
      await this.ctx.suspend();
      this._playing = false;
    }
  }

  /** Linear gain 0–1. Applied when the audio graph exists. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.gain) {
      this.gain.gain.value = this.volume;
    }
  }

  /**
   * Stop sources and clear queues, but keep AudioContext + gain
   * so volume and user-gesture unlock survive Stop / replay.
   */
  resetPlayback(): void {
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.activeSources = 0;
    this.pending = new Uint8Array(0);
    this.coalesce = new Uint8Array(0);
    this.bufferedBeforeStart = 0;
    this.started = false;
    this._playing = false;
    this._ended = false;
    this.streamComplete = false;
    this.nextTime = 0;
    this.anchorMediaTime = 0;
    this.anchorCtxTime = 0;
    this.clockRunning = false;
    this.startMediaOffset = 0;
    this._duration = 0;
  }

  /** Play PCM from an optional media offset (seconds). */
  async playBuffer(pcm: Uint8Array, offsetSeconds = 0): Promise<void> {
    this.resetPlayback();

    const usable =
      pcm.byteLength - (pcm.byteLength % PCM_BYTES_PER_SAMPLE);
    if (usable < PCM_BYTES_PER_SAMPLE) {
      this.finish();
      return;
    }

    const totalSamples = usable / PCM_BYTES_PER_SAMPLE;
    this._duration = totalSamples / PCM_SAMPLE_RATE;

    const clampedOffset = Math.min(
      Math.max(0, offsetSeconds),
      Math.max(0, this._duration - 0.05),
    );
    const startSample = Math.floor(clampedOffset * PCM_SAMPLE_RATE);
    const byteOffset = startSample * PCM_BYTES_PER_SAMPLE;
    this.startMediaOffset = startSample / PCM_SAMPLE_RATE;

    const data = pcm.subarray(byteOffset, usable);
    for (let offset = 0; offset < data.byteLength; offset += SCHEDULE_CHUNK_BYTES) {
      const end = Math.min(offset + SCHEDULE_CHUNK_BYTES, data.byteLength);
      const block = data.subarray(offset, end);
      const blockUsable =
        block.byteLength - (block.byteLength % PCM_BYTES_PER_SAMPLE);
      if (blockUsable >= PCM_BYTES_PER_SAMPLE) {
        this.schedulePcm(block.subarray(0, blockUsable));
      }
    }

    await this.tryStart();
    this.markStreamComplete();
  }

  /** Append a PCM chunk; may start playback once enough data is buffered. */
  async feed(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;

    // Align to 16-bit sample boundaries
    const merged = concatBytes(this.pending, chunk);
    const usable = merged.byteLength - (merged.byteLength % PCM_BYTES_PER_SAMPLE);
    this.pending =
      usable < merged.byteLength
        ? merged.slice(usable)
        : new Uint8Array(0);
    if (usable === 0) return;

    const pcm = merged.subarray(0, usable);
    this.coalesce = concatBytes(this.coalesce, pcm);

    if (!this.started) {
      this.bufferedBeforeStart += pcm.byteLength;
    }

    while (this.coalesce.byteLength >= SCHEDULE_CHUNK_BYTES) {
      const block = this.coalesce.subarray(0, SCHEDULE_CHUNK_BYTES);
      this.coalesce = this.coalesce.slice(SCHEDULE_CHUNK_BYTES);
      this.schedulePcm(block);
    }

    if (!this.started && this.bufferedBeforeStart >= START_BUFFER_BYTES) {
      // Flush any remainder so start isn't waiting on a full schedule block
      if (this.coalesce.byteLength >= PCM_BYTES_PER_SAMPLE * 64) {
        const block = this.coalesce;
        this.coalesce = new Uint8Array(0);
        this.schedulePcm(block);
      }
      await this.tryStart();
    }
  }

  /** Call when the full report stream has finished. */
  markStreamComplete(): void {
    this.streamComplete = true;
    this.flushCoalesce();
    if (this.started && this.activeSources === 0) {
      this.finish();
    }
  }

  /** More segments will follow — do not treat as end of playback yet. */
  prepareNextSegment(): void {
    this.streamComplete = false;
  }

  /** Tear down completely (unmount). */
  stop(): void {
    this.resetPlayback();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.gain = null;
    }
  }

  private flushCoalesce(): void {
    if (this.coalesce.byteLength >= PCM_BYTES_PER_SAMPLE) {
      const usable =
        this.coalesce.byteLength -
        (this.coalesce.byteLength % PCM_BYTES_PER_SAMPLE);
      if (usable > 0) {
        const block = this.coalesce.subarray(0, usable);
        this.coalesce = new Uint8Array(0);
        this.schedulePcm(block);
      }
    }
  }

  private schedulePcm(pcm: Uint8Array): void {
    const ctx = this.ensureContext();
    if (!this.gain) return;

    const sampleCount = pcm.byteLength / PCM_BYTES_PER_SAMPLE;
    if (sampleCount === 0) return;

    // Copy into a tight buffer so DataView isn't tied to a large parent array
    const copy = pcm.slice();
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    const buffer = ctx.createBuffer(1, sampleCount, PCM_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * PCM_BYTES_PER_SAMPLE, true) / 32768;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const startAt = Math.max(this.nextTime, ctx.currentTime + 0.05);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(source);
    this.activeSources += 1;

    source.onended = () => {
      this.sources.delete(source);
      this.activeSources -= 1;
      if (
        this.streamComplete &&
        this.activeSources === 0 &&
        this.coalesce.byteLength < 2 &&
        this.pending.byteLength < 2
      ) {
        this.finish();
      }
    };
  }

  private async tryStart(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const ctx = this.ensureContext();
    try {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      this._playing = ctx.state === 'running';
      if (!this._playing) {
        this.anchorMediaTime = this.startMediaOffset;
        this.onAutoplayBlocked?.();
      } else {
        this.armClock(this.startMediaOffset);
        this.onStart?.();
      }
    } catch {
      this.anchorMediaTime = this.startMediaOffset;
      this.onAutoplayBlocked?.();
    }
  }

  private finish(): void {
    if (this._ended) return;
    this._ended = true;
    this._playing = false;
    this.clockRunning = false;
    if (this._duration > 0) {
      this.anchorMediaTime = this._duration;
    } else {
      this.anchorMediaTime = this.getCurrentTime();
    }
    this.onEnded?.();
  }
}

export function concatPcmChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!.slice();
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b.slice();
  if (b.byteLength === 0) return a.slice();
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
