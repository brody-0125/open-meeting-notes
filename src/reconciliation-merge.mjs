import { createHash } from 'node:crypto';
import { runJob } from './jobs.mjs';
import { validateSummary } from './contracts.mjs';
import { validateReconciliationPlan } from './inference/reconciliation-plan.mjs';
import { buildReconciliationRequest, validateReconciliation } from './inference/reconciliation.mjs';
import { validateCandidateGroups, validateGroupSummary } from './inference/reconciliation-groups.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The whole source was scanned first. These are literal evidence windows, not a
// replacement transcript: keep their source coordinates and label their scope.
export function prepareScanMerge(transcript, scan) {
  const original = structuredClone(transcript), scanned = structuredClone(scan);
  if (!Array.isArray(original?.segments) || scanned?.state !== 'scanned' || !Array.isArray(scanned.leaves) ||
      scanned.leaves.length > 2000 || !Number.isSafeInteger(scanned.totalWindows) || scanned.totalWindows < 0) throw new Error('complete scan required');
  buildReconciliationRequest({ revision: original.revision,
    transcript: original.segments.map(({ id, rawText }) => ({ id, rawText })), candidates: [] });
  validateReconciliationPlan({ version: 1, revision: original.revision,
    parts: scanned.leaves.map((leaf, index) => ({ index, segments: leaf.segments })) }, original);
  const byId = new Map(original.segments.map((s, index) => [s.id, { ...s, index }]));
  const candidates = [], windows = [], seen = new Set();
  let previous = -1;
  for (const [leafIndex, leaf] of scanned.leaves.entries()) {
    const key = `${leaf.index}:${leaf.path}`;
    if (!Number.isSafeInteger(leaf.index) || leaf.index < 0 || leaf.index >= scanned.totalWindows ||
        leaf.index < previous || leaf.index > previous + 1 || typeof leaf.path !== 'string' || !/^[01]{0,4}$/.test(leaf.path) ||
        seen.has(key)) throw new Error('invalid scan order');
    seen.add(key); previous = leaf.index;
    validateReconciliation(leaf.result, { revision: original.revision, candidates: [],
      transcript: leaf.segments.map(({ id, rawText }) => ({ id, rawText })) });
    for (const [itemIndex, item] of leaf.result.items.entries()) {
      if (candidates.length >= 2000) throw new Error('too many merge candidates');
      const { candidateIds, ...claim } = item;
      const uniqueEvidence = [...new Map(item.evidence.map(e => [JSON.stringify([e.segmentId, e.quote]), e])).values()];
      const evidence = uniqueEvidence.map(e => {
        const range = leaf.segments.find(s => s.id === e.segmentId), source = byId.get(e.segmentId);
        const start = range.start + range.rawText.indexOf(e.quote), end = start + e.quote.length;
        let contextStart = Math.max(0, start - 80), contextEnd = Math.min(source.rawText.length, end + 80);
        if (contextStart > 0 && /[\uDC00-\uDFFF]/.test(source.rawText[contextStart])) contextStart--;
        if (contextEnd < source.rawText.length && /[\uDC00-\uDFFF]/.test(source.rawText[contextEnd])) contextEnd++;
        windows.push({ segmentId: source.id, order: source.index, start: contextStart, end: contextEnd });
        return { ...e, start, end };
      });
      candidates.push({ id: `p${leafIndex}:i${itemIndex}`, item: { ...claim, evidence } });
    }
  }
  if (previous + 1 !== scanned.totalWindows) throw new Error('incomplete scan windows');
  windows.sort((a, b) => a.order - b.order || a.start - b.start);
  const sources = [];
  for (const window of windows) {
    const last = sources.at(-1);
    if (last?.segmentId === window.segmentId && last.end >= window.start) last.end = Math.max(last.end, window.end);
    else sources.push({ id: `m${sources.length}`, segmentId: window.segmentId, start: window.start, end: window.end });
  }
  const input = { revision: original.revision,
    transcript: sources.map(s => ({ id: s.id, rawText: byId.get(s.segmentId).rawText.slice(s.start, s.end) })),
    candidates: candidates.map(c => ({ ...c, item: { ...c.item, evidence: c.item.evidence.map(e => ({
      segmentId: sources.find(s => s.segmentId === e.segmentId && s.start <= e.start && s.end >= e.end).id, quote: e.quote
    })) } })) };
  buildReconciliationRequest(input, { sourceScope: 'excerpts' });
  return { input, sources };
}

export async function mergeScannedWindows({ jobs, descriptor, transcript, scan, execute, signal, strategy = 'direct' }) {
  const original = structuredClone(transcript), scanned = structuredClone(scan), base = structuredClone(descriptor);
  signal?.throwIfAborted();
  if (typeof execute !== 'function' || base.revision !== original.revision) throw new Error('invalid merge execution');
  if (!['direct', 'grouped'].includes(strategy)) throw new Error('invalid merge strategy');
  const prepared = prepareScanMerge(original, scanned);
  let result, groupPlan;
  if (strategy === 'grouped') {
    groupPlan = await runJob(jobs, { ...base, kind: 'group-reconciliation', inputHash: hash(prepared),
      settingsHash: hash({ parent: base.settingsHash, stage: 'group-plan-v1' }) },
      () => execute('group-reconciliation', { reconciliation: structuredClone(prepared.input), modelHash: base.modelHash }),
      value => validateCandidateGroups(value, prepared.input), { signal });
    result = { version: 1, revision: original.revision, items: [] };
    for (const group of groupPlan.groups) {
      const candidates = prepared.input.candidates.filter(c => group.candidateIds.includes(c.id));
      const ids = new Set(candidates.flatMap(c => c.item.evidence.map(e => e.segmentId)));
      const input = { revision: original.revision, candidates, transcript: prepared.input.transcript.filter(s => ids.has(s.id)) };
      const summary = await runJob(jobs, { ...base, kind: 'reconcile', inputHash: hash({ input, group }),
        settingsHash: hash({ parent: base.settingsHash, stage: 'group-summary-v2-status-first' }) },
        () => execute('reconcile', { reconciliation: structuredClone(input), sourceScope: 'excerpts', groupKind: group.kind, modelHash: base.modelHash }),
        value => validateGroupSummary(value, input, group), { signal });
      result.items.push(...summary.items);
    }
    validateReconciliation(result, prepared.input);
  } else result = await runJob(jobs, { ...base, kind: 'reconcile', inputHash: hash({ original, scanned, prepared }),
    settingsHash: hash({ parent: base.settingsHash, stage: 'scan-merge-v3-explicit-grouping', sourceScope: 'excerpts' }) },
    () => execute('reconcile', { reconciliation: structuredClone(prepared.input), sourceScope: 'excerpts', modelHash: base.modelHash }),
    value => validateReconciliation(value, prepared.input), { signal });
  const byId = new Map(prepared.sources.map(s => [s.id, s]));
  const mapped = { ...structuredClone(result), items: result.items.map(item => ({ ...structuredClone(item),
    evidence: item.evidence.map(e => ({ segmentId: byId.get(e.segmentId).segmentId, quote: e.quote })) })) };
  const summary = { version: mapped.version, revision: mapped.revision,
    items: mapped.items.map(({ candidateIds, ...item }) => item) };
  validateSummary(summary, original.segments.map(s => ({ id: s.id, text: s.rawText })), original.revision);
  return { state: 'complete', basis: 'scanned-excerpts', summary, result: mapped,
    mergeResult: result, sources: prepared.sources, ...(groupPlan ? { groupPlan } : {}) };
}
