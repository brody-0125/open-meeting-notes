// Silero 16 kHz protocol: 512 new samples, 64 context, [2,1,128] state.
// Caller must reset on discontinuity and treat rejection as unhealthy audio.
export class SileroFrames {
  #states = new Map();
  #busy = false;
  constructor(run) {
    if (typeof run !== 'function') throw new Error('VAD runner required');
    this.run = run;
  }
  reset(source) {
    if (this.#busy) throw new Error('VAD busy');
    if (source === undefined) this.#states.clear();
    else { checkSource(source); this.#states.delete(source); }
  }
  async process(source, frame) {
    checkSource(source);
    if (this.#busy) throw new Error('VAD busy');
    if (!(frame instanceof Float32Array) || frame.length !== 512 || frame.some(x => !Number.isFinite(x) || Math.abs(x) > 1)) throw new Error('invalid VAD frame');
    const previous = this.#states.get(source);
    const samples = new Float32Array(576);
    if (previous) samples.set(previous.context);
    samples.set(frame, 64);
    const context = samples.slice(-64);
    this.#busy = true;
    try {
      const result = await this.run({ samples, state: previous?.state.slice() ?? new Float32Array(256) });
      if (!Number.isFinite(result?.probability) || result.probability < 0 || result.probability > 1 ||
        !(result.state instanceof Float32Array) || result.state.length !== 256 || result.state.some(x => !Number.isFinite(x))) throw new Error('invalid VAD output');
      this.#states.set(source, { context, state: result.state.slice() });
      return { probability: result.probability, speech: result.probability >= 0.5 };
    } catch (error) {
      this.#states.delete(source);
      throw error;
    } finally { this.#busy = false; }
  }
}
function checkSource(source) {
  if (!['microphone', 'remote'].includes(source)) throw new Error('invalid VAD source');
}

// Caller owns the detector exclusively for this clip. Zero detected frames is
// a measurement, not proof of silence or permission to discard the recording.
export async function measureSpeech(detector, { source, sampleRate, samples }, { signal } = {}) {
  checkSource(source);
  if (sampleRate !== 16000 || !(samples instanceof Float32Array) || samples.length < 1 || samples.length > 480000 ||
      samples.some(x => !Number.isFinite(x) || Math.abs(x) > 1)) throw new Error('invalid VAD clip');
  signal?.throwIfAborted();
  detector.reset(source);
  try {
    let frames = 0, speechFrames = 0, maximumProbability = 0;
    const speechRanges = [];
    for (let offset = 0; offset < samples.length; offset += 512) {
      signal?.throwIfAborted();
      const frame = new Float32Array(512);
      frame.set(samples.subarray(offset, offset + 512));
      const { probability } = await detector.process(source, frame);
      signal?.throwIfAborted();
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('invalid VAD probability');
      maximumProbability = Math.max(maximumProbability, probability);
      speechFrames += probability >= .5 ? 1 : 0;
      if (probability >= .5) {
        const endFrame = Math.min(offset + 512, samples.length), previous = speechRanges.at(-1);
        if (previous?.endFrame === offset) previous.endFrame = endFrame;
        else speechRanges.push({ startFrame: offset, endFrame });
      }
      frames++;
    }
    return { frames, speechFrames, maximumProbability, speechRanges };
  } finally { detector.reset(source); }
}
