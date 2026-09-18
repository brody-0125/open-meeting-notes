import { CreateMLCEngine } from '@mlc-ai/web-llm';
// 0.1.6 ships UMD despite its ESM package metadata; browser export is global.
import '@mlc-ai/web-tokenizers';
import { summarizeTranscript, buildSummaryRequest } from './summary.mjs';
import { qwenPromptParts, assertSummaryBudget } from './summary-budget.mjs';
import { partitionSummary } from './summary-partition.mjs';
import { normalizeQwenResponse } from './qwen-response.mjs';
import { modelBase } from './model-location.mjs';
import { reconcileCandidates } from './reconciliation.mjs';
import { planReconciliation } from './reconciliation-plan.mjs';
import { groupCandidates } from './reconciliation-groups.mjs';

export async function loadSummarizer({ onProgress, modelHash } = {}) {
  const base = modelBase(modelHash);
  const id = modelHash ? `local-qwen-${modelHash}` : 'local-qwen';
  const directory = `${base}models/qwen/resolve/main/`;
  const configResponse = await fetch(`${directory}mlc-chat-config.json`);
  if (!configResponse.ok) throw new Error('local summary config unavailable');
  const config = await configResponse.json();
  qwenPromptParts(buildSummaryRequest({ revision: 0, segments: [] }), config);
  const tokenizerResponse = await fetch(`${directory}tokenizer.json`);
  if (!tokenizerResponse.ok) throw new Error('local summary tokenizer unavailable');
  const tokenizer = await globalThis.tokenizers.Tokenizer.fromJSON(await tokenizerResponse.arrayBuffer());
  const count = request => qwenPromptParts(request, config).reduce((n, part) => n + tokenizer.encode(part).length, 0);
  let engine;
  try { engine = await CreateMLCEngine(id, {
    initProgressCallback: onProgress,
    appConfig: { cacheBackend: 'indexeddb', model_list: [{
      model_id: id, model: `${base}models/qwen/resolve/main/`,
      model_lib: `${base}runtime/qwen.wasm`, overrides: { context_window_size: 4096 }
    }] }
  }); } catch (error) { tokenizer.dispose(); throw error; }
  const generate = async (request, options) => {
      const measured = assertSummaryBudget(request, count(request));
      // Independent partitions must not inherit earlier chat history or KV usage.
      await engine.resetChat();
      options?.signal?.throwIfAborted();
      const response = await engine.chat.completions.create(request);
      if (response.usage?.prompt_tokens !== measured) throw new Error('summary tokenizer disagrees with engine prompt usage');
      return normalizeQwenResponse(response);
  };
  return {
    plan: (transcript, options = {}) => partitionSummary(transcript, input => count(buildSummaryRequest(input)), { ...options, maxTokens: 3072 }),
    planReconciliation: (transcript, options) => planReconciliation(transcript, count, options),
    summarize: (transcript, options) => summarizeTranscript(request => generate(request, options), transcript, options),
    reconcile: (input, options) => reconcileCandidates(request => generate(request, options), input, { ...options, countTokens: count }),
    group: (input, options) => groupCandidates(request => generate(request, options), input, { ...options, countTokens: count }),
    interrupt: () => engine.interruptGenerate(),
    dispose: async () => { try { await engine.unload(); } finally { tokenizer.dispose(); } }
  };
}
