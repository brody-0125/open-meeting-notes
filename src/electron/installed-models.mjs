import { verifyModelPack, readVerifiedModelAsset } from '../model-pack.mjs';
import { isAbsolute, join } from 'node:path';

export function installationRoot(root, baseDirectory) {
  if (typeof root !== 'string') throw new Error('invalid model installation');
  if (isAbsolute(root)) return root; // Model verifier retains absolute-path checks.
  if (!baseDirectory || !isAbsolute(baseDirectory)) throw new Error('absolute installation base required');
  if (!root.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) && !part.endsWith('.') &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('unsafe relative model path');
  return join(baseDirectory, root);
}

// Configuration is trusted installation metadata, never renderer input or an
// approval file read automatically from inside an untrusted model directory.
export async function installedModels(config, { baseDirectory } = {}) {
  const files = new Map();
  const packs = new Map();
  const status = { stt: null, summary: null, vad: null };
  if (config === undefined) return { files, status, packs };
  if (!config || config.version !== 1 || Object.keys(config).some(k => !['version', 'stt', 'summary', 'vad'].includes(k))) throw new Error('invalid model installation');
  for (const kind of ['stt', 'summary', 'vad']) {
    const record = config[kind];
    if (!record) continue;
    if (typeof record.root !== 'string' || kind === 'stt' && (typeof record.modelId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(record.modelId))) throw new Error('invalid model installation');
    const engine = kind === 'stt' ? 'transformers' : kind === 'vad' ? 'silero' : 'webllm';
    const engineVersion = kind === 'stt' ? '4.3.0' : kind === 'vad' ? '1.31.0-dev.20260914-8d85527a0' : '0.2.85';
    const pack = await verifyModelPack({ root: installationRoot(record.root, baseDirectory), approvedManifestHash: record.approvedManifestHash, engine, engineVersion });
    packs.set(kind, pack);
    const prefix = kind === 'stt' ? `models/${record.modelId}/` : 'models/qwen/resolve/main/';
    const runtimes = kind === 'stt' ? ['runtime/ort-wasm-simd-threaded.jsep.mjs', 'runtime/ort-wasm-simd-threaded.jsep.wasm',
      'runtime/ort-wasm-simd-threaded.asyncify.mjs', 'runtime/ort-wasm-simd-threaded.asyncify.wasm'] : kind === 'vad'
      ? ['models/silero.onnx', 'vad-runtime/ort-wasm-simd-threaded.mjs', 'vad-runtime/ort-wasm-simd-threaded.wasm'] : ['runtime/qwen.wasm'];
    for (const file of pack.files) {
      const route = `/packs/${pack.manifestHash}/${file.path}`;
      if ((!(kind !== 'vad' && file.path.startsWith(prefix)) && !runtimes.includes(file.path)) || files.has(route)) throw new Error('model route conflict');
      files.set(route, () => readVerifiedModelAsset(pack, file));
    }
    status[kind] = { modelHash: pack.manifestHash, modelId: kind === 'stt' ? record.modelId : kind === 'vad' ? 'silero' : pack.id };
  }
  return { files, status, packs };
}
