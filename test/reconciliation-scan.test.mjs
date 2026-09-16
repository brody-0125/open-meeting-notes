import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.mjs';
import { scanReconciliationWindows } from '../src/reconciliation-scan.mjs';
import { validateReconciliationPlan } from '../src/inference/reconciliation-plan.mjs';

const transcript = { revision: 1, segments: [{ id: 'a', rawText: '화요일에 엽니다.' }, { id: 'b', rawText: '화요일 결정을 취소합니다.' }] };
const plan = { version: 1, revision: 1, parts: transcript.segments.map((s, index) => ({ index,
  segments: [{ ...s, start: 0, end: s.rawText.length }] })) };
const descriptor = { version: 1, sessionId: 'scan-test', kind: 'reconcile', revision: 1,
  inputHash: 'a'.repeat(64), modelHash: 'b'.repeat(64), settingsHash: 'c'.repeat(64) };
const response = input => ({ version: 1, revision: 1, items: [{ kind: 'topic', text: input.transcript[0].rawText,
  status: 'candidate', candidateIds: [], evidence: [{ segmentId: input.transcript[0].id, quote: input.transcript[0].rawText }] }] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omn-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a failed scan preserves earlier windows; a fresh store retries only unfinished work', async t => {
  const root = await fixture(t), calls = [];
  let fail = true;
  const execute = async (operation, input) => {
    assert.equal(operation, 'reconcile'); calls.push(input.windowIndex);
    if (input.windowIndex === 1 && fail) throw new Error('device lost');
    return response(input.reconciliation);
  };
  const run = () => scanReconciliationWindows({ jobs: new JobStore(root), descriptor, plan, transcript, execute });
  const partial = await run();
  assert.equal(partial.state, 'partial'); assert.equal(partial.leaves.length, 1);
  assert.equal(partial.failedWindow, 1); assert.equal(partial.totalWindows, 2);
  fail = false; calls.length = 0;
  const scanned = await run();
  assert.deepEqual(calls, [1]); assert.equal(scanned.state, 'scanned');
  assert.equal(scanned.leaves.length, 2);
  assert.equal(Object.hasOwn(scanned, 'summary'), false); // Scanning is not global reconciliation.
  calls.length = 0; assert.deepEqual(await run(), scanned); assert.deepEqual(calls, []);
  for (const change of [{ modelHash: 'd'.repeat(64) }, { settingsHash: 'e'.repeat(64) }]) {
    calls.length = 0;
    const updated = await scanReconciliationWindows({ jobs: new JobStore(root), descriptor: { ...descriptor, ...change },
      plan, transcript, execute });
    assert.equal(updated.state, 'scanned'); assert.deepEqual(calls, [0, 1]);
  }
});

test('a quote from outside this window fails even when present elsewhere in the meeting', async t => {
  const root = await fixture(t);
  const scanned = await scanReconciliationWindows({ jobs: new JobStore(root), descriptor, plan, transcript,
    execute: async (_operation, input) => {
      const result = response(input.reconciliation);
      result.items[0].evidence = [{ segmentId: 'b', quote: transcript.segments[1].rawText }];
      return result;
    } });
  assert.equal(scanned.state, 'partial'); assert.equal(scanned.leaves.length, 0);
  assert.match(scanned.error, /evidence/);
});

test('cancelled late output is not cached, while the preceding window remains reusable', async t => {
  const root = await fixture(t), controller = new AbortController();
  await assert.rejects(scanReconciliationWindows({ jobs: new JobStore(root), descriptor, plan, transcript, signal: controller.signal,
    execute: async (_operation, input) => { if (input.windowIndex === 1) controller.abort(); return response(input.reconciliation); }
  }), { name: 'AbortError' });
  const calls = [];
  const scanned = await scanReconciliationWindows({ jobs: new JobStore(root), descriptor, plan, transcript,
    execute: async (_operation, input) => { calls.push(input.windowIndex); return response(input.reconciliation); } });
  assert.deepEqual(calls, [1]); assert.equal(scanned.state, 'scanned');
});

test('invalid coverage or stale revision is rejected before executing any window', async t => {
  const root = await fixture(t);
  const base = { jobs: new JobStore(root), descriptor, plan, transcript, execute: () => assert.fail('no inference') };
  await assert.rejects(scanReconciliationWindows({ ...base, plan: { ...plan, parts: plan.parts.slice(1) } }));
  await assert.rejects(scanReconciliationWindows({ ...base, descriptor: { ...descriptor, revision: 2 } }), /revision/);
});

test('output-limit subdivision preserves Unicode ranges and resumes without regenerating failed parents', async t => {
  const root = await fixture(t), calls = [], controller = new AbortController();
  const source = { revision: 1, segments: [{ id: 'a', rawText: '앞😀뒤🙂끝' }] };
  const whole = { version: 1, revision: 1, parts: [{ index: 0,
    segments: [{ ...source.segments[0], start: 0, end: source.segments[0].rawText.length }] }] };
  let cancel = true;
  const execute = async (_op, input) => {
    const text = input.reconciliation.transcript.map(s => s.rawText).join(''); calls.push(text);
    if (text === source.segments[0].rawText) throw Object.assign(new Error('length'), { code: 'OUTPUT_LIMIT' });
    if (cancel && text === '뒤🙂끝') controller.abort();
    return response(input.reconciliation);
  };
  const run = signal => scanReconciliationWindows({ jobs: new JobStore(root), descriptor, plan: whole, transcript: source, execute, signal });
  await assert.rejects(run(controller.signal), { name: 'AbortError' });
  cancel = false; calls.length = 0;
  const result = await run();
  assert.equal(result.state, 'scanned'); assert.deepEqual(calls, ['뒤🙂끝']);
  assert.equal(result.leaves.length, 2);
  validateReconciliationPlan({ version: 1, revision: 1,
    parts: result.leaves.map((leaf, index) => ({ index, segments: leaf.segments })) }, source);
  calls.length = 0; assert.deepEqual(await run(), result); assert.deepEqual(calls, []);
});

test('only explicit output-limit errors split; depth exhaustion stays partial', async t => {
  const root = await fixture(t);
  for (const code of [undefined, 'DEVICE_LOST', 'OUTPUT_LIMIT']) {
    let calls = 0;
    const source = { revision: 1, segments: [{ id: 'a', rawText: '가'.repeat(1024) }] };
    const whole = { version: 1, revision: 1, parts: [{ index: 0,
      segments: [{ ...source.segments[0], start: 0, end: 1024 }] }] };
    const result = await scanReconciliationWindows({ jobs: new JobStore(join(root, String(code))), descriptor,
      transcript: source, plan: whole, execute: async () => { calls++; throw Object.assign(new Error('failure'), { code }); } });
    assert.equal(result.state, 'partial'); assert.equal(result.leaves.length, 0);
    assert.equal(calls, code === 'OUTPUT_LIMIT' ? 5 : 1);
    if (code === 'OUTPUT_LIMIT') assert.match(result.error, /subdivision limit/);
  }
});
