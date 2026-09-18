import * as ort from 'onnxruntime-web/wasm';
import { SileroFrames, measureSpeech } from '../audio/vad.mjs';
import { modelBase } from './model-location.mjs';
export { measureSpeech } from '../audio/vad.mjs';

export async function loadSilero({ modelHash } = {}) {
  const base = modelBase(modelHash);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: `${base}vad-runtime/ort-wasm-simd-threaded.mjs`,
    wasm: `${base}vad-runtime/ort-wasm-simd-threaded.wasm`
  };
  const session = await ort.InferenceSession.create(`${base}models/silero.onnx`, { executionProviders: ['wasm'] });
  let disposed = false;
  let active;
  const frames = new SileroFrames(async ({ samples, state }) => {
    const out = await session.run({
      input: new ort.Tensor('float32', samples, [1, 576]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.of(16000n), [])
    });
    return { probability: out.output.data[0], state: out.stateN.data };
  });
  return {
    measure(input) { return measureSpeech(this, input); },
    async process(source, frame) {
      if (disposed) throw new Error('VAD disposed');
      if (active) throw new Error('VAD busy');
      active = frames.process(source, frame);
      try { return await active; } finally { active = undefined; }
    },
    reset(source) { if (disposed) throw new Error('VAD disposed'); frames.reset(source); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await active; } catch { /* Failed inference still releases session. */ }
      await session.release();
    }
  };
}
