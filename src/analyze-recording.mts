import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ChunkStore } from './store.mjs';
import { inspectRecording } from './recording-seal.mjs';
import { JobStore, runJob } from './jobs.mjs';
import { transcriptionJobs } from './transcription-jobs.mjs';
import { assembleTranscript, summaryInput, hasUnconfirmedSpeech } from './transcript.mjs';
import { validateSummary } from './contracts.mjs';
import { validateSummaryPartitions, summarizePartitions } from './inference/summary-partition.mjs';
import { CorrectionStore } from './corrections.mjs';
import { ReviewStore, speechReviewKey } from './reviews.mjs';
import { reconciliationInput, validateReconciliation } from './inference/reconciliation.mjs';
import { sttSettingsHash, assertAnalysisLanguageMatchesSttLocale } from './stt-settings.mjs';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function analyzeRecording({ root, models, execute, signal, language = 'ko', mode = 'full' }) {
  if (!['full', 'transcribe', 'summarize'].includes(mode)) throw new Error('invalid analyze mode');
  if (!models?.stt) throw new Error('local models required');
  if (mode !== 'transcribe' && !models?.summary) throw new Error('local models required');
  if (!['ko', 'en'].includes(language)) throw new Error('unsupported language');
  assertAnalysisLanguageMatchesSttLocale(models.stt, language);
  signal?.throwIfAborted();
  const recording = await inspectRecording(root);
  if (recording.state !== 'complete') throw new Error('complete recording required');
  signal?.throwIfAborted();
  const jobs = new JobStore(join(root, 'jobs'));
  const audio = new ChunkStore(root), completed = [];
  const settingsHash = sttSettingsHash({ stt: models.stt, language, vadModelHash: models.vad?.modelHash ?? null });
  const transcribe = mode !== 'summarize';
  for (const source of ['microphone', 'remote']) {
    const config = { sessionId: recording.sessionId, source, revision: 1, modelHash: models.stt.modelHash, settingsHash,
      pauses: recording.pauses ?? [] };
    for await (const job of transcriptionJobs(audio, recording.index, jobs, config, (window, { key }) => transcribe
      ? execute('transcribe', { window, key, language, ...models.stt, vadModelHash: models.vad?.modelHash ?? null })
      : Promise.reject(new Error('saved transcript required before summary')), { signal })) completed.push(job);
  }
  const transcript = await new CorrectionStore(join(root, 'corrections')).load(assembleTranscript(completed, 1,
    { pauses: recording.pauses ?? [], formats: recording.formats }));
  const speechReviews = new ReviewStore(join(root, 'speech-reviews'));
  for (const segment of transcript.segments) if (segment.flags.includes('speech-unconfirmed'))
    segment.speechReview = await speechReviews.get(speechReviewKey(transcript, segment));
  signal?.throwIfAborted();
  if (transcript.conflicts.length || transcript.gaps.length || hasUnconfirmedSpeech(transcript)) return { transcript, summary: null, needsReview: true };
  if (mode === 'transcribe') return { transcript, summary: null, needsReview: false };
  const input = summaryInput(transcript);
  if (!input.segments.length) return { transcript, summary: null, needsReview: false };
  const descriptor = { version: 1, sessionId: recording.sessionId, kind: 'summarize', revision: input.revision,
    inputHash: sha(input), modelHash: models.summary.modelHash,
    settingsHash: sha({ engine: 'webllm-0.2.85', tokenizer: 'web-tokenizers-0.1.6', prompt: 'classification-v4-source-ids', partition: 1, maxTokens: 1024, temperature: 0, context: 4096 }) };
  try {
    const plan = await runJob(jobs, { ...descriptor, kind: 'plan-summary' },
      () => execute('plan-summary', { transcript: input, modelHash: models.summary.modelHash }),
      result => validateSummaryPartitions(result, input), { signal });
    const summaryParts = await summarizePartitions(plan, (part, index) => runJob(jobs,
      { ...descriptor, inputHash: sha({ original: descriptor.inputHash, index, part }) },
      () => execute('summarize', { transcript: part, modelHash: models.summary.modelHash, partIndex: index, totalParts: plan.length }),
      result => validateSummary(result, part.segments.map(s => ({ id: s.id, text: s.rawText })), input.revision), { signal }), { signal });
    summaryParts.total = plan.length;
    if (summaryParts.state === 'complete' && plan.length > 1) {
      try {
        const reconciliation = reconciliationInput(input, summaryParts);
        const result = await runJob(jobs, { ...descriptor, kind: 'reconcile', inputHash: sha(reconciliation),
          settingsHash: sha({ engine: 'webllm-0.2.85', prompt: 'reconciliation-v7-literal-quotes', maxTokens: 1024, temperature: 0, context: 4096 }) },
          () => execute('reconcile', { reconciliation, modelHash: models.summary.modelHash }),
          value => validateReconciliation(value, reconciliation), { signal });
        return { transcript, summaryParts, summary: validateReconciliation(result, reconciliation),
          reconciliation: { state: 'complete', result }, needsReview: false };
      } catch (error) {
        signal?.throwIfAborted();
        return { transcript, summaryParts, summary: null, reconciliation: { state: 'failed' },
          ...(['CONTEXT_LIMIT', 'OUTPUT_LIMIT'].includes(error.code) ? { summaryErrorCode: error.code } : {}),
          needsReview: false, summaryError: String(error.message).slice(0, 1000) };
      }
    }
    return { transcript, summary: summaryParts.state === 'complete' && plan.length === 1 ? summaryParts.parts[0].summary : null,
      summaryParts, needsReview: false, ...(summaryParts.state === 'partial' ? { summaryError: summaryParts.error } : {}) };
  } catch (error) {
    signal?.throwIfAborted();
    return { transcript, summary: null, needsReview: false,
      ...(['CONTEXT_LIMIT', 'OUTPUT_LIMIT'].includes(error.code) ? { summaryErrorCode: error.code } : {}),
      summaryError: String(error.message).slice(0, 1000) };
  }
}
