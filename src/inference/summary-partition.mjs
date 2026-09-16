import { validateSummary } from '../contracts.mjs';
import { buildSummaryRequest } from './summary.mjs';

// Main rechecks Worker plans, including cached plans, before trusting their coverage.
export function validateSummaryPartitions(parts, transcript) {
  if (!Array.isArray(parts)) throw new Error('invalid summary plan');
  let index = 0, offset = 0;
  const ranges = [];
  for (const [partIndex, part] of parts.entries()) {
    if (part?.revision !== transcript.revision || !part.segments?.length) throw new Error('invalid summary plan revision');
    buildSummaryRequest(part);
    const range = { index: partIndex, segments: [] };
    for (const piece of part.segments) {
      const original = transcript.segments[index];
      if (!original || piece.id !== original.id || (!piece.rawText.length && original.rawText.length) ||
          !original.rawText.startsWith(piece.rawText, offset)) throw new Error('summary plan changed original text');
      const end = offset + piece.rawText.length;
      if (end > 0 && end < original.rawText.length &&
          /[\uD800-\uDBFF]/.test(original.rawText[end - 1]) && /[\uDC00-\uDFFF]/.test(original.rawText[end])) throw new Error('summary plan splits Unicode code point');
      range.segments.push({ id: piece.id, start: offset, end, rawText: piece.rawText });
      offset = end;
      if (offset === original.rawText.length) { index++; offset = 0; }
    }
    ranges.push(range);
  }
  if (index !== transcript.segments.length || offset) throw new Error('summary plan omitted original text');
  return ranges;
}

// countTokens must measure the complete request with the model's tokenizer.
// maxTokens is input allowance AFTER reserving output; measurement includes template overhead.
export async function partitionSummary(transcript, countTokens, { maxTokens = 2048, maxChars = 12000, maxSegments = 200, signal } = {}) {
  if (typeof countTokens !== 'function' || [maxTokens, maxChars, maxSegments].some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('invalid partition limits');
  const input = structuredClone(transcript);
  if (!Number.isSafeInteger(input?.revision) || input.revision < 0 || !Array.isArray(input.segments)) throw new Error('invalid transcript');
  const ids = new Set();
  for (const s of input.segments) {
    if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/.test(s.id) || ids.has(s.id) || typeof s.rawText !== 'string') throw new Error('invalid segment');
    ids.add(s.id);
  }
  const parts = [];
  let pending = [];
  const flush = () => { if (pending.length) { parts.push({ revision: input.revision, segments: pending }); pending = []; } };
  const fits = async segments => {
    signal?.throwIfAborted();
    if (segments.length > maxSegments || segments.reduce((n, s) => n + s.rawText.length, 0) > maxChars) return false;
    const tokens = await countTokens({ revision: input.revision, segments });
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('invalid measured token count');
    return tokens <= maxTokens;
  };
  for (const segment of input.segments) {
    signal?.throwIfAborted();
    if (await fits([...pending, segment])) { pending.push(segment); continue; }
    flush();
    if (await fits([segment])) { pending.push(segment); continue; }
    // Split by Unicode code points; retain the original ID so every quote still
    // resolves into the original unmodified rawText when results are validated.
    const points = [...segment.rawText];
    if (!points.length) throw new Error('segment metadata cannot fit input budget');
    let offset = 0;
    while (offset < points.length) {
      let lo = 1, hi = Math.min(points.length - offset, maxChars), best = 0;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = { id: segment.id, rawText: points.slice(offset, offset + mid).join('') };
        if (await fits([candidate])) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (!best) throw new Error('segment cannot fit input budget');
      const piece = { id: segment.id, rawText: points.slice(offset, offset + best).join('') };
      // Recheck even when a tokenizer's count is not monotonic across prefixes.
      if (!await fits([piece])) throw new Error('unstable token measurement');
      pending = [piece]; offset += best;
      if (offset < points.length) flush();
    }
  }
  flush();
  return parts;
}

// Per-part candidates only. Cross-part contradictions need a separate review or
// reconciliation stage; concatenation is not a globally reconciled meeting note.
export async function summarizePartitions(parts, summarize, { signal } = {}) {
  const inputs = structuredClone(parts), completed = [];
  if (!Array.isArray(inputs) || typeof summarize !== 'function') throw new Error('invalid summary partitions');
  for (let index = 0; index < inputs.length; index++) {
    signal?.throwIfAborted();
    const input = inputs[index];
    try {
      const summary = await summarize(structuredClone(input), index);
      signal?.throwIfAborted();
      validateSummary(summary, input.segments.map(s => ({ id: s.id, text: s.rawText })), input.revision);
      completed.push({ index, summary });
    } catch (error) {
      signal?.throwIfAborted();
      return { state: 'partial', parts: completed, failedPart: index, error: String(error.message).slice(0, 1000) };
    }
  }
  return { state: 'complete', parts: completed };
}
