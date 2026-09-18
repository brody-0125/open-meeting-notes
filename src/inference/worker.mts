import { inferenceKey } from './model-location.mjs';
let model, modelKey, busy = false;
// Dynamic import is deliberate: only the requested runtime is initialized.
// The host serves these bundles and models from its verified local allowlist.
self.onmessage = async ({ data }) => {
  const { id, operation, input } = data ?? {};
  if (!Number.isSafeInteger(id) || !['transcribe', 'summarize', 'plan-summary', 'plan-reconciliation', 'group-reconciliation', 'reconcile', 'vad-load', 'vad', 'measure-speech'].includes(operation)) return;
  if (busy) { self.postMessage({ id, type: 'error', message: 'inference worker busy' }); return; }
  busy = true;
  try {
    const key = inferenceKey(operation, input);
    if (key !== modelKey) {
      await model?.dispose();
      model = undefined; modelKey = undefined;
      if (operation === 'transcribe') {
        const { loadWhisper } = await import('omn://app/whisper.mjs');
        model = await loadWhisper({ modelId: input.modelId, device: input.device, dtype: input.dtype, modelHash: input.modelHash });
      } else if (operation === 'vad' || operation === 'vad-load' || operation === 'measure-speech') {
        const { loadSilero } = await import('omn://app/silero.mjs');
        model = await loadSilero({ modelHash: input.modelHash });
      } else {
        const { loadSummarizer } = await import('omn://app/summarizer.mjs');
        model = await loadSummarizer({ modelHash: input.modelHash });
      }
      modelKey = key;
    }
    const result = operation === 'transcribe' ? await model.transcribe(input.audio, { language: input.language ?? 'ko' })
      : operation === 'measure-speech' ? await model.measure(input.audio)
      : operation === 'vad-load' ? { ready: true } : operation === 'vad' ? await model.process(input.source, input.samples)
      : operation === 'plan-summary' ? await model.plan(input.transcript)
      : operation === 'plan-reconciliation' ? await model.planReconciliation(input.transcript)
      : operation === 'group-reconciliation' ? await model.group(input.reconciliation)
      : operation === 'reconcile' ? await model.reconcile(input.reconciliation, { sourceScope: input.sourceScope ?? 'full', groupKind: input.groupKind }) : await model.summarize(input.transcript);
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message ?? 'inference failed',
      ...(['OUTPUT_LIMIT', 'CONTEXT_LIMIT'].includes(error.code) ? { code: error.code } : {}) });
  } finally { busy = false; }
};
