import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.mjs';
import { prepareScanMerge, mergeScannedWindows } from '../src/reconciliation-merge.mjs';

const transcript = { revision: 1, segments: [
  { id: 'early', rawText: '회의는 화요일에 엽니다.' },
  { id: 'long', rawText: '아직 결정하지 않았습니다. '.repeat(1000) },
  { id: 'late', rawText: '화요일 결정을 취소합니다. 목요일에 엽니다.' }
] };
const ranges = transcript.segments.flatMap(s => s.id === 'long' ? [0, 7500].map(start => ({ ...s, start, end: start + 7500,
  rawText: s.rawText.slice(start, start + 7500) })) : [{ ...s, start: 0, end: s.rawText.length }]);
const scan = { state: 'scanned', totalWindows: 4, leaves: ranges.map((s, index) => ({ index, path: '',
  segments: [s], result: { version: 1, revision: 1, items: [{
    kind: 'topic', status: 'candidate', text: '생성 문장에는 의존하지 않는다.', candidateIds: [],
    evidence: [{ segmentId: s.id, quote: s.id === 'long' ? '아직 결정하지 않았습니다.' : s.rawText }]
  }] } })) };
const descriptor = { version: 1, sessionId: 'merge-test', kind: 'reconcile', revision: 1,
  inputHash: 'a'.repeat(64), modelHash: 'b'.repeat(64), settingsHash: 'c'.repeat(64) };
const response = input => ({ version: 1, revision: 1, items: input.candidates.map(c => ({
  ...structuredClone(c.item), candidateIds: [c.id]
})) });

test('merge input retains every scanned candidate, original excerpt locations and nearby context', () => {
  const before = structuredClone({ transcript, scan });
  const prepared = prepareScanMerge(transcript, scan);
  assert.equal(prepared.input.candidates.length, 4);
  assert.ok(prepared.input.transcript.reduce((n, s) => n + s.rawText.length, 0) < 1000);
  for (const source of prepared.sources) {
    const original = transcript.segments.find(s => s.id === source.segmentId);
    assert.equal(prepared.input.transcript.find(s => s.id === source.id).rawText, original.rawText.slice(source.start, source.end));
  }
  assert.ok(prepared.input.transcript.some(s => s.rawText.includes('화요일 결정을 취소합니다.')));
  assert.deepEqual({ transcript, scan }, before);
});

test('partial, omitted, reordered and invalid evidence scans cannot reach merging', () => {
  for (const mutate of [
    s => s.state = 'partial', s => s.leaves.pop(), s => s.leaves.reverse(),
    s => s.leaves[1].segments[0].start++,
    s => s.leaves[1].result.items[0].evidence[0].quote = '없는 원문'
  ]) {
    const bad = structuredClone(scan); mutate(bad);
    assert.throws(() => prepareScanMerge(transcript, bad));
  }
});

test('excerpt context never cuts a Unicode pair and overlapping evidence keeps one source window', () => {
  const text = '😀'.repeat(100) + '. 결정합니다. ' + '😀'.repeat(100);
  const original = { revision: 1, segments: [{ id: 'unicode', rawText: text }] };
  const leaf = { index: 0, path: '', segments: [{ id: 'unicode', start: 0, end: text.length, rawText: text }],
    result: { version: 1, revision: 1, items: [0, 1].map(() => ({ kind: 'decision', text: '결정', status: 'candidate',
      candidateIds: [], evidence: Array.from({ length: 5 }, () => ({ segmentId: 'unicode', quote: '결정합니다.' })) })) } };
  const prepared = prepareScanMerge(original, { state: 'scanned', totalWindows: 1, leaves: [leaf] });
  assert.equal(prepared.sources.length, 1); assert.equal(prepared.input.candidates.length, 2);
  assert.ok(prepared.input.candidates.every(c => c.item.evidence.length === 1));
  const excerpt = prepared.input.transcript[0].rawText;
  assert.equal(/[\uDC00-\uDFFF]/.test(excerpt[0]), false);
  assert.equal(/[\uD800-\uDBFF]/.test(excerpt.at(-1)), false);
  assert.ok(excerpt.includes('결정합니다.'));
});

test('merge rejects excessive candidates before constructing their complete excerpt catalog', () => {
  const original = { revision: 1, segments: Array.from({ length: 21 }, (_, index) => ({ id: `s${index}`, rawText: '검토합니다.' })) };
  const large = { state: 'scanned', totalWindows: 21, leaves: original.segments.map((s, index) => ({
    index, path: '', segments: [{ ...s, start: 0, end: s.rawText.length }], result: { version: 1, revision: 1,
      items: Array.from({ length: 100 }, () => ({ kind: 'topic', text: '검토', status: 'candidate', candidateIds: [],
        evidence: [{ segmentId: s.id, quote: s.rawText }] })) }
  })) };
  assert.throws(() => prepareScanMerge(original, large), /too many merge candidates/);
});

test('merged result maps to original IDs and caches only complete candidate coverage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-merge-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0, omit = true;
  const execute = async (operation, input) => {
    assert.equal(operation, 'reconcile'); calls++;
    assert.equal(input.sourceScope, 'excerpts');
    const result = response(input.reconciliation);
    if (omit) result.items.pop();
    return result;
  };
  const run = () => mergeScannedWindows({ jobs: new JobStore(root), descriptor, transcript, scan, execute });
  await assert.rejects(run(), /omitted candidates/);
  omit = false; const completed = await run();
  assert.equal(completed.state, 'complete'); assert.equal(calls, 2);
  assert.deepEqual(completed.summary.items.map(i => i.evidence[0].segmentId), ['early', 'long', 'long', 'late']);
  assert.deepEqual(completed.result.items.flatMap(i => i.candidateIds), ['p0:i0', 'p1:i0', 'p2:i0', 'p3:i0']);
  assert.ok(completed.mergeResult.items.every(i => i.evidence[0].segmentId.startsWith('m')));
  assert.deepEqual(await run(), completed); assert.equal(calls, 2);
});

test('cancelled merge completion is never reused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-merge-')); t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController(); let calls = 0;
  const execute = async (_operation, input) => { calls++; controller.abort(); return response(input.reconciliation); };
  const args = { jobs: new JobStore(root), descriptor, transcript, scan, execute };
  await assert.rejects(mergeScannedWindows({ ...args, signal: controller.signal }), { name: 'AbortError' });
  await mergeScannedWindows({ ...args, jobs: new JobStore(root) });
  assert.equal(calls, 2);
});

test('grouped merge rejects incomplete plans and resumes only unfinished groups', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-groups-')); t.after(() => rm(root, { recursive: true, force: true }));
  let invalid = true, fail = true, plans = 0;
  const calls = [];
  const execute = async (operation, input) => {
    if (operation === 'group-reconciliation') {
      plans++;
      const groups = input.reconciliation.candidates.map(c => ({ subject: c.id, kind: 'topic', candidateIds: [c.id] }));
      if (invalid) groups.pop();
      return { version: 1, revision: 1, groups };
    }
    assert.equal(operation, 'reconcile'); assert.equal(input.groupKind, 'topic');
    assert.equal(input.reconciliation.transcript.length, 1);
    const id = input.reconciliation.candidates[0].id; calls.push(id);
    if (fail && id === 'p1:i0') throw new Error('injected failure');
    return response(input.reconciliation);
  };
  const run = (modelHash = descriptor.modelHash) => mergeScannedWindows({ jobs: new JobStore(root), descriptor: { ...descriptor, modelHash }, transcript, scan, execute, strategy: 'grouped' });
  await assert.rejects(run(), /omitted/); assert.deepEqual(calls, []);
  invalid = false; await assert.rejects(run(), /injected/);
  fail = false; const result = await run();
  assert.equal(plans, 2);
  assert.deepEqual(calls, ['p0:i0', 'p1:i0', 'p1:i0', 'p2:i0', 'p3:i0']);
  assert.deepEqual(result.summary.items.map(i => i.evidence[0].segmentId), ['early', 'long', 'long', 'late']);
  assert.deepEqual(await run(), result); assert.equal(calls.length, 5);
  await run('d'.repeat(64));
  assert.equal(plans, 3); assert.equal(calls.length, 9, 'new model cannot reuse earlier plan or summaries');
});

test('grouped merge discards cancelled or wrongly classified output while retaining its plan', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-group-cancel-')); t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController(); let plans = 0, calls = 0, mode = 'cancel';
  const execute = async (operation, input) => {
    if (operation === 'group-reconciliation') {
      plans++;
      return { version: 1, revision: 1, groups: input.reconciliation.candidates.map(c => ({
        subject: c.id, kind: 'topic', candidateIds: [c.id]
      })) };
    }
    calls++;
    const result = response(input.reconciliation);
    if (mode === 'cancel') controller.abort();
    if (mode === 'wrong') result.items[0].kind = 'decision';
    return result;
  };
  const run = signal => mergeScannedWindows({ jobs: new JobStore(root), descriptor, transcript, scan, execute, strategy: 'grouped', signal });
  await assert.rejects(run(controller.signal), { name: 'AbortError' });
  mode = 'wrong'; await assert.rejects(run(), /group summary/);
  mode = 'valid'; await run();
  assert.equal(plans, 1); assert.equal(calls, 6);
});
