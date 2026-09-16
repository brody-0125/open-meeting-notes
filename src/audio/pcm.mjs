// Browser/AudioWorklet compatible. No Node imports, network or resampling.
export class PcmChunker {
  #buffer;
  #view;
  #used = 0;
  #frame = 0;
  #seq = 0;
  #stopped = false;
  #paused = false;
  constructor({ sessionId, source, sampleRate, chunkFrames = sampleRate }, emit) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(sessionId) || !['microphone', 'remote'].includes(source)) throw new Error('invalid capture identity');
    if (![16000, 44100, 48000].includes(sampleRate) || !Number.isSafeInteger(chunkFrames) || chunkFrames < 1 || chunkFrames > sampleRate * 5) throw new Error('invalid capture format');
    this.meta = { version: 1, sessionId, epoch: 0, source, sampleRate, channels: 1 };
    this.chunkFrames = chunkFrames;
    this.emit = emit;
    this.#buffer = new ArrayBuffer(chunkFrames * 2);
    this.#view = new DataView(this.#buffer);
  }
  push(channels) {
    if (this.#stopped) throw new Error('capture stopped');
    if (this.#paused) throw new Error('capture paused');
    if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2 ||
      !channels.every(c => c instanceof Float32Array && c.length === channels[0].length && c.length > 0)) throw new Error('invalid input channels');
    if (!Number.isSafeInteger(this.#frame + this.#used + channels[0].length)) throw new Error('capture frame overflow');
    // Validate first: a rejected block must not partially advance the timeline.
    for (const channel of channels) for (const value of channel) if (!Number.isFinite(value)) throw new Error('non-finite PCM');
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      value = Math.max(-1, Math.min(1, value));
      this.#view.setInt16(this.#used * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      this.#used++;
      if (this.#used === this.chunkFrames) this.#flush();
    }
  }
  pause() {
    if (this.#stopped) throw new Error('capture stopped');
    if (this.#paused) throw new Error('capture already paused');
    this.#paused = true;
    this.#flush();
    return this.#frame;
  }
  // Caller supplies elapsed frames from the capture clock, never a wall timer.
  // The resulting gap must be persisted as an explicit pause before UI exposure.
  resume(skippedFrames) {
    if (this.#stopped) throw new Error('capture stopped');
    if (!this.#paused) throw new Error('capture not paused');
    if (!Number.isSafeInteger(skippedFrames) || skippedFrames < 0 || !Number.isSafeInteger(this.#frame + skippedFrames))
      throw new Error('invalid pause duration');
    this.#frame += skippedFrames;
    this.#paused = false;
  }
  #flush() {
    if (!this.#used) return;
    const frames = this.#used;
    const pcm = this.#buffer.slice(0, frames * 2);
    const meta = { ...this.meta, seq: this.#seq++, startFrame: this.#frame, frames };
    this.#frame += frames;
    this.#used = 0;
    this.emit({ meta, pcm });
  }
  stop() {
    if (!this.#stopped) { this.#stopped = true; this.#flush(); }
    return this.#frame;
  }
}
