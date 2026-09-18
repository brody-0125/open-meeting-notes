export function modelBase(modelHash) {
  // Unversioned path is retained for isolated legacy integration harnesses.
  if (modelHash === undefined) return 'omn://app/';
  if (typeof modelHash !== 'string' || !/^[a-f0-9]{64}$/.test(modelHash)) throw new Error('invalid model hash');
  return `omn://app/packs/${modelHash}/`;
}
export function inferenceKey(operation, input) {
  const base = modelBase(input.modelHash);
  if (operation === 'vad' || operation === 'vad-load' || operation === 'measure-speech') return JSON.stringify(['vad', base]);
  return JSON.stringify(operation === 'transcribe' ? [operation, base, input.modelId, input.device ?? 'wasm', input.dtype ?? 'q8'] : ['summarize', base]);
}
