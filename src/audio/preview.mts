export class AudioPreview {
  #active;
  constructor(createContext = () => new AudioContext()) { this.createContext = createContext; }
  stop() {
    const run = this.#active; this.#active = undefined;
    if (!run) return;
    if (run.node) { run.node.onended = null; if (run.started) run.node.stop(); }
    void run.context.close().catch(() => {});
    run.onState('idle');
  }
  async play(load, onState = () => {}) {
    this.stop();
    const run = this.#active = { context: this.createContext(), onState };
    try {
      onState('loading');
      // Resume during the user's click, before asynchronous local file reading.
      const [, audio] = await Promise.all([run.context.resume(), (async () => load())()]);
      if (this.#active !== run) return;
      if (![16000, 44100, 48000].includes(audio.sampleRate) || !(audio.samples instanceof Float32Array) ||
          !audio.samples.length || audio.samples.length > audio.sampleRate * 30 ||
          !audio.samples.every(Number.isFinite)) throw new Error('invalid preview audio');
      const buffer = run.context.createBuffer(1, audio.samples.length, audio.sampleRate);
      buffer.copyToChannel(audio.samples, 0);
      run.node = run.context.createBufferSource(); run.node.buffer = buffer;
      run.node.connect(run.context.destination);
      run.node.onended = () => { if (this.#active === run) this.stop(); };
      run.node.start(); run.started = true; onState('playing');
    } catch (error) {
      if (this.#active !== run) return;
      this.stop(); throw error;
    }
  }
}
