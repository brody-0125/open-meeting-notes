import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.mjs';
import { reconcileLongTranscript } from '../src/reconciliation-scan.mjs';

const transcript = { revision: 1, segments: [{ id: 'a', rawText: '회의는 화요일입니다.' }, { id: 'b', rawText: '목요일로 변경합니다.' }] };
const descriptor = { version: 1, sessionId: 'long-flow', kind: 'reconcile', revision: 1,
  inputHash: 'a'.repeat(64), modelHash: 'b'.repeat(64), settingsHash: 'c'.repeat(64) };
function response(operation, input) {
  if (operation === 'plan-reconciliation') return { version: 1, revision: input.transcript.revision,
    parts: input.transcript.segments.map((s, index) => ({ index, segments: [{ ...s, start: 0, end: s.rawText.length }] })) };
  if (operation === 'group-reconciliation') return { version: 1, revision: 1,
    groups: input.reconciliation.candidates.map(c => ({ subject: c.id, kind: 'topic', candidateIds: [c.id] })) };
  const source = input.reconciliation.transcript[0];
  return { version: 1, revision: 1, items: [{ kind: 'topic', status: 'candidate', text: source.rawText,
    candidateIds: input.reconciliation.candidates.map(c => c.id), evidence: [{ segmentId: source.id, quote: source.rawText }] }] };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omn-long-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('long pipeline persists its plan, resumes scan then failed group only, and replays without inference', async t => {
  const root = await fixture(t), calls = [];
  let failure = 'scan';
  const execute = async (operation, input) => {
    const label = operation === 'reconcile' ? input.sourceScope === 'excerpts' ? `merge:${input.reconciliation.candidates[0].id}` : `scan:${input.windowIndex}` : operation;
    calls.push(label);
    if (failure === 'scan' && label === 'scan:1' || failure === 'merge' && label === 'merge:p1:i0') throw new Error('injected failure');
    return response(operation, input);
  };
  const run = () => reconcileLongTranscript({ jobs: new JobStore(root), descriptor, transcript, execute });
  const partial = await run();
  assert.equal(partial.state, 'partial'); assert.equal(partial.summary, null);
  assert.equal(partial.scan.leaves.length, 1);
  assert.deepEqual(calls, ['plan-reconciliation', 'scan:0', 'scan:1']);
  failure = 'merge'; calls.length = 0;
  await assert.rejects(run(), /injected failure/);
  assert.deepEqual(calls, ['scan:1', 'group-reconciliation', 'merge:p0:i0', 'merge:p1:i0']);
  failure = undefined; calls.length = 0;
  const result = await run();
  assert.deepEqual(calls, ['merge:p1:i0']);
  assert.equal(result.state, 'complete'); assert.equal(result.scan.state, 'scanned');
  assert.deepEqual(result.summary.items.map(i => i.evidence[0].segmentId), ['a', 'b']);
  calls.length = 0; assert.deepEqual(await run(), result); assert.deepEqual(calls, []);
});

test('invalid source coverage never reaches scan and a cancelled plan cannot be reused', async t => {
  const root = await fixture(t), controller = new AbortController();
  let calls = 0, mode = 'omit';
  const run = signal => reconcileLongTranscript({ jobs: new JobStore(root), descriptor, transcript, signal,
    execute: async (operation, input) => {
      assert.equal(operation, 'plan-reconciliation'); calls++;
      const plan = response(operation, input);
      if (mode === 'omit') plan.parts.pop(); else controller.abort();
      return plan;
    } });
  await assert.rejects(run(), /omitted/); await assert.rejects(run(), /omitted/);
  mode = 'cancel'; await assert.rejects(run(controller.signal), { name: 'AbortError' });
  mode = 'omit'; await assert.rejects(run(), /omitted/);
  assert.equal(calls, 4);
});

test('plan cache identity includes actual source and model, independent of a caller supplied input hash', async t => {
  const root = await fixture(t), calls = [];
  const run = (source, base) => reconcileLongTranscript({ jobs: new JobStore(root), descriptor: base, transcript: source,
    execute: async (operation, input) => { calls.push(operation); return response(operation, input); } });
  await run(transcript, descriptor);
  for (const [source, base] of [[transcript, { ...descriptor, modelHash: 'd'.repeat(64) }],
    [{ ...transcript, segments: [{ id: 'a', rawText: '금요일로 변경합니다.' }] }, descriptor]]) {
    calls.length = 0; await run(source, base);
    assert.equal(calls[0], 'plan-reconciliation'); assert.ok(calls.includes('group-reconciliation'));
  }
  await assert.rejects(run(transcript, { ...descriptor, revision: 2 }), /revision/);
});
