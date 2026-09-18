import { partitionSummary, validateSummaryPartitions } from './summary-partition.mjs';
import { buildReconciliationRequest } from './reconciliation.mjs';

const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(k => !Object.hasOwn(value, k))) throw new Error('invalid reconciliation plan fields');
};

// Source coverage only. This plan is not a reconciled result or proof of meaning.
// Later merge stages must budget their own candidate/evidence input separately.
export async function planReconciliation(transcript, countRequestTokens, { inputLimit = 3072, signal } = {}) {
  const input = structuredClone(transcript);
  if (!Number.isSafeInteger(inputLimit) || inputLimit < 1 || inputLimit > 3072) throw new Error('invalid reconciliation input limit');
  if (typeof countRequestTokens !== 'function') throw new Error('token measurement required');
  signal?.throwIfAborted();
  buildReconciliationRequest({ revision: input.revision, transcript: input.segments, candidates: [] });
  const parts = await partitionSummary(input, part => countRequestTokens(buildReconciliationRequest({
    revision: part.revision, transcript: part.segments, candidates: []
  })), { maxTokens: inputLimit, signal });
  signal?.throwIfAborted();
  const plan = { version: 1, revision: input.revision, parts: validateSummaryPartitions(parts, input) };
  validateReconciliationPlan(plan, input);
  return plan;
}

// Main can recheck Worker/cache coverage without trusting token counts from them.
// Offsets are UTF-16 indices into the unchanged original rawText, not byte offsets.
export function validateReconciliationPlan(plan, transcript) {
  exact(plan, ['version', 'revision', 'parts']);
  if (plan.version !== 1 || plan.revision !== transcript.revision || !Array.isArray(plan.parts) || plan.parts.length > 20000) throw new Error('invalid reconciliation plan');
  const parts = plan.parts.map((part, index) => {
    exact(part, ['index', 'segments']);
    if (part.index !== index || !Array.isArray(part.segments)) throw new Error('invalid reconciliation part');
    return { revision: plan.revision, segments: part.segments.map(segment => {
      exact(segment, ['id', 'start', 'end', 'rawText']);
      if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || segment.start < 0 || segment.end < segment.start) throw new Error('invalid source range');
      return { id: segment.id, rawText: segment.rawText };
    }) };
  });
  const expected = validateSummaryPartitions(parts, transcript);
  for (const [i, part] of expected.entries()) for (const [j, range] of part.segments.entries()) {
    const actual = plan.parts[i].segments[j];
    if (actual.start !== range.start || actual.end !== range.end) throw new Error('incorrect reconciliation source range');
  }
}
