import { env, pipeline } from '@huggingface/transformers';
import { transcribeChunk } from './transcription.mjs';
import { modelBase } from './model-location.mjs';

// The host only exposes files from a verified, immutable model pack at these
// origins. The module is bundled locally; no CDN or Hub access is permitted.
export async function loadWhisper({ modelId, device = 'wasm', dtype = 'q8', modelHash }) {
  const base = modelBase(modelHash);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(modelId) || !['wasm', 'webgpu'].includes(device)) throw new Error('invalid local model configuration');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = `${base}models/`;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useWasmCache = false;
  const runtime = device === 'webgpu' ? 'ort-wasm-simd-threaded.asyncify' : 'ort-wasm-simd-threaded.jsep';
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${base}runtime/${runtime}.mjs`,
    wasm: `${base}runtime/${runtime}.wasm`
  };
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  const recognizer = await pipeline('automatic-speech-recognition', modelId, { device, dtype, local_files_only: true });
  return {
    transcribe: (input, options) => transcribeChunk(recognizer, input, options),
    dispose: () => recognizer.dispose()
  };
}
