import { createHash } from 'node:crypto';
import { jobKey, runJob } from './jobs.mjs';
import { validateReconciliationPlan } from './inference/reconciliation-plan.mjs';
import { validateReconciliation } from './inference/reconciliation.mjs';
import { mergeScannedWindows } from './reconciliation-merge.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Experimental end-to-end path. Completion validates coverage and structure,
// not semantic accuracy; keep the product gate until semantic regressions pass.
export async function reconcileLongTranscript({ jobs, descriptor, transcript, execute, signal }) {
  const input = structuredClone(transcript), base = structuredClone(descriptor);
  signal?.throwIfAborted();
  if (base.revision !== input.revision) throw new Error('stale reconciliation revision');
  if (typeof execute !== 'function') throw new Error('reconciliation executor required');
  const plan = await runJob(jobs, { ...base, kind: 'plan-reconciliation', inputHash: hash(input),
    settingsHash: hash({ parent: base.settingsHash, stage: 'reconciliation-plan-v1', inputLimit: 3072 }) },
    () => execute('plan-reconciliation', { transcript: structuredClone(input), modelHash: base.modelHash }),
    value => validateReconciliationPlan(value, input), { signal });
  const scan = await scanReconciliationWindows({ jobs, descriptor: base, transcript: input, plan, execute, signal });
  if (scan.state !== 'scanned') return { state: 'partial', stage: 'scan', scan, summary: null };
  const merged = await mergeScannedWindows({ jobs, descriptor: base, transcript: input, scan, execute, signal, strategy: 'grouped' });
  return { ...merged, scan };
}

function subdivide(segments) {
  if (segments.length > 1) {
    const middle = Math.floor(segments.length / 2);
    return [segments.slice(0, middle), segments.slice(middle)];
  }
  const segment = segments[0], points = Array.from(segment.rawText);
  if (points.length < 2) return null;
  const left = points.slice(0, Math.floor(points.length / 2)).join('');
  const boundary = segment.start + left.length;
  return [[{ ...segment, end: boundary, rawText: left }],
    [{ ...segment, start: boundary, rawText: segment.rawText.slice(left.length) }]];
}

// Persisted source-window processing only; a later stage must reconcile these
// leaves together. Never label a set of independent leaves as a final summary.
export async function scanReconciliationWindows({ jobs, descriptor, plan, transcript, execute, signal }) {
  const input = structuredClone(transcript), ranges = structuredClone(plan), base = structuredClone(descriptor);
  signal?.throwIfAborted();
  if (typeof execute !== 'function') throw new Error('window executor required');
  if (base.revision !== input.revision) throw new Error('stale scan revision');
  validateReconciliationPlan(ranges, input);
  const sourceHash = hash({ transcript: input, plan: ranges });
  const settingsHash = hash({ parent: base.settingsHash, stage: 'reconciliation-window-v4-literal-quotes', maxSplitDepth: 4 });
  jobKey({ ...base, kind: 'reconcile-window', inputHash: sourceHash, settingsHash });
  const leaves = [];
  async function scan(index, segments, path = '') {
    signal?.throwIfAborted();
    const reconciliation = { revision: input.revision, candidates: [],
      transcript: segments.map(({ id, rawText }) => ({ id, rawText })) };
    const children = path.length < 4 ? subdivide(segments) : null;
    const record = await runJob(jobs, { ...base, kind: 'reconcile-window', settingsHash,
      inputHash: hash({ sourceHash, index, path, segments }) }, async () => {
        try {
          const result = await execute('reconcile', { reconciliation: structuredClone(reconciliation), modelHash: base.modelHash,
            windowIndex: index, totalWindows: ranges.parts.length, subdivision: path });
          return { state: 'complete', result };
        } catch (error) {
          signal?.throwIfAborted();
          if (error.code !== 'OUTPUT_LIMIT') throw error;
          if (!children) throw new Error('reconciliation subdivision limit reached');
          // Persist the split decision, never a truncated model response.
          return { state: 'split' };
        }
      }, record => {
        if (record?.state === 'split' && Object.keys(record).length === 1 && children) return;
        if (record?.state !== 'complete' || Object.keys(record).length !== 2) throw new Error('invalid scan record');
        validateReconciliation(record.result, reconciliation);
      }, { signal });
    if (record.state === 'split') {
      await scan(index, children[0], `${path}0`);
      await scan(index, children[1], `${path}1`);
    } else leaves.push({ index, path, segments, result: record.result });
  }
  for (const part of ranges.parts) {
    try {
      await scan(part.index, part.segments);
    } catch (error) {
      signal?.throwIfAborted();
      return { state: 'partial', totalWindows: ranges.parts.length, leaves,
        failedWindow: part.index, error: String(error.message).slice(0, 1000) };
    }
  }
  return { state: 'scanned', totalWindows: ranges.parts.length, leaves };
}
