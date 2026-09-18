import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore } from '../../src/jobs.mjs';
import { reconcileLongTranscript } from '../../src/reconciliation-scan.mjs';
import { validateReconciliationPlan } from '../../src/inference/reconciliation-plan.mjs';
import { prepareScanMerge } from '../../src/reconciliation-merge.mjs';

test('real long pipeline resumes persisted planning and scanning, then checks merge semantics independently', { timeout: 600000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-real-scan-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const transcript = { revision: 1, segments: [
    { id: 'early', rawText: '회의는 화요일에 엽니다.' },
    { id: 'long', rawText: '아직 결정하지 않았습니다. '.repeat(1000) },
    { id: 'late', rawText: '화요일 결정을 취소합니다. 목요일에 엽니다.' }
  ] };
  const modelHash = await page.evaluate(async () => {
    const models = await window.meeting.models();
    if (models.error || !models.summary) throw new Error(JSON.stringify(models));
    const { InferenceClient } = await import('/inference-client.mjs');
    globalThis.scanClient = new InferenceClient();
    return models.summary.modelHash;
  });
  const descriptor = { version: 1, sessionId: 'real-scan', kind: 'reconcile', revision: 1,
    inputHash: 'a'.repeat(64), modelHash, settingsHash: 'b'.repeat(64) };
  let fail = true;
  const calls = [];
  const execute = async (operation, input) => {
    calls.push({ operation, windowIndex: input.windowIndex });
    if (fail && input.windowIndex === 1) throw new Error('injected between-window failure');
    const reply = await page.evaluate(async ({ operation, input }) => {
      try { return { result: await scanClient.run(operation, input) }; }
      catch (error) { return { error: error.message, code: error.code }; }
    }, { operation, input });
    if (reply.error) throw Object.assign(new Error(reply.error), ['OUTPUT_LIMIT', 'CONTEXT_LIMIT'].includes(reply.code) ? { code: reply.code } : {});
    return reply.result;
  };
  const run = () => reconcileLongTranscript({ jobs: new JobStore(join(directory, 'scan-jobs')),
    descriptor, transcript, execute });
  const partial = await run();
  assert.equal(partial.state, 'partial'); assert.equal(partial.scan.leaves.length, 1);
  assert.equal(partial.summary, null);
  assert.deepEqual(calls, [{ operation: 'plan-reconciliation', windowIndex: undefined },
    { operation: 'reconcile', windowIndex: 0 }, { operation: 'reconcile', windowIndex: 1 }]);
  fail = false; calls.length = 0;
  const merged = await run(), scanned = merged.scan;
  t.diagnostic(JSON.stringify({ stage: 'resume', state: scanned.state, saved: scanned.leaves.length,
    failedWindow: scanned.failedWindow, error: scanned.error, calls }));
  assert.equal(scanned.state, 'scanned', scanned.error); assert.ok(scanned.totalWindows > 1);
  assert.equal(calls.some(c => c.operation === 'plan-reconciliation' || c.windowIndex === 0), false);
  assert.deepEqual([...new Set(calls.filter(c => c.windowIndex !== undefined).map(c => c.windowIndex))],
    Array.from({ length: scanned.totalWindows - 1 }, (_, i) => i + 1));
  validateReconciliationPlan({ version: 1, revision: transcript.revision,
    parts: scanned.leaves.map((leaf, index) => ({ index, segments: leaf.segments })) }, transcript);
  assert.ok(scanned.leaves.some(p => p.result.items.length > 0));
  assert.equal(Object.hasOwn(scanned, 'summary'), false);
  if (process.env.OMN_SYNTHETIC_SCAN_OUTPUT) await writeFile(process.env.OMN_SYNTHETIC_SCAN_OUTPUT,
    JSON.stringify({ transcript, scanned, descriptor, prepared: prepareScanMerge(transcript, scanned) }, null, 2));
  assert.equal(merged.state, 'complete'); assert.equal(merged.basis, 'scanned-excerpts');
  await t.test('full pipeline replay performs no inference', async () => {
    calls.length = 0; assert.deepEqual(await run(), merged); assert.deepEqual(calls, []);
  });
  await t.test('merge preserves the changed decision and separate unspecified topic', () => {
  const decision = merged.summary.items.find(item => item.kind === 'decision' && /목요일/.test(item.text));
  assert.ok(decision, JSON.stringify(merged.summary));
  assert.match(decision.text, /취소|변경/);
  assert.ok(decision.evidence.some(e => e.segmentId === 'early'));
  assert.ok(decision.evidence.some(e => e.segmentId === 'late'));
  assert.ok(merged.summary.items.some(item => item.kind === 'topic' && /결정|미정/.test(item.text)));
  assert.ok(!merged.summary.items.some(item => item.kind === 'decision' && item.evidence.some(e => e.segmentId === 'long')));
  });
  t.diagnostic(JSON.stringify({ stage: 'merge', summary: merged.summary,
    candidateCoverage: merged.result.items.map(item => item.candidateIds), cachedMergeCalls: calls.length }));
  await page.evaluate(() => scanClient.dispose());
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
  t.diagnostic(JSON.stringify({ windows: scanned.totalWindows, state: scanned.state,
    itemCounts: scanned.leaves.map(p => p.result.items.length), cachedReplayCalls: calls.length }));
});
