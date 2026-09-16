import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { JobStore } from '../../src/jobs.mjs';
import { mergeScannedWindows } from '../../src/reconciliation-merge.mjs';

// Reuses the real synthetic scan saved by test:reconciliation-scan. It still
// revalidates source coverage and evidence; it does not regenerate that scan.
const referenceGroups = process.env.OMN_DIAGNOSTIC_GROUP_PLAN === 'reference';
test(referenceGroups ? 'DIAGNOSTIC: supplied reference groups → actual Worker summaries (not end-to-end quality)' :
  'saved long scan → actual Worker merge → original evidence → cached replay', { timeout: 180000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE && process.env.OMN_SYNTHETIC_SCAN_OUTPUT);
  const fixtureBytes = await readFile(process.env.OMN_SYNTHETIC_SCAN_OUTPUT);
  const fixture = JSON.parse(fixtureBytes.toString('utf8'));
  if (referenceGroups) {
    assert.equal(process.env.OMN_MERGE_STRATEGY, 'grouped');
    assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),
      'd35dc04617a793e26fd2a07f35757193b268021d100e265c9cd1df94ae8466c1', 'reference labels apply only to this frozen fixture');
  }
  const directory = await mkdtemp(join(tmpdir(), 'omn-saved-merge-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const modelHash = await page.evaluate(async () => {
    const { InferenceClient } = await import('/inference-client.mjs');
    globalThis.mergeClient = new InferenceClient();
    return (await window.meeting.models()).summary.modelHash;
  });
  // Default remains same-model. An explicit source hash permits a controlled
  // merge-only comparison without relabelling the model that produced the scan.
  const scanModelHash = process.env.OMN_SCAN_MODEL_HASH ?? modelHash;
  assert.equal(fixture.descriptor.modelHash, scanModelHash, 'scan must belong to the declared source model');
  t.diagnostic(JSON.stringify({ scanModelHash, mergeModelHash: modelHash,
    fixtureHash: createHash('sha256').update(fixtureBytes).digest('hex') }));
  let calls = 0;
  const execute = async (operation, input) => {
    calls++;
    if (referenceGroups && operation === 'group-reconciliation') return { version: 1, revision: 1, groups: [
      { subject: '회의 일정 변경', kind: 'decision', candidateIds: ['p0:i0', 'p3:i1'] },
      { subject: '대상 미지정 미정 사항', kind: 'topic', candidateIds: ['p1:i0', 'p2:i0', 'p3:i0'] }
    ] };
    return page.evaluate(({ operation, input }) => mergeClient.run(operation, input), { operation, input });
  };
  const run = () => mergeScannedWindows({ jobs: new JobStore(join(directory, 'jobs')), descriptor: { ...fixture.descriptor, modelHash },
    transcript: fixture.transcript, scan: fixture.scanned, execute, strategy: process.env.OMN_MERGE_STRATEGY ?? 'direct' });
  const result = await run();
  t.diagnostic(JSON.stringify({ summary: result.summary, coverage: result.result.items.map(i => i.candidateIds), groupPlan: result.groupPlan }));
  await t.test('durable replay makes no additional inference calls', async () => {
    const expectedCalls = process.env.OMN_MERGE_STRATEGY === 'grouped' ? 1 + result.summary.items.length : 1;
    assert.equal(calls, expectedCalls);
    assert.deepEqual(await run(), result); assert.equal(calls, expectedCalls);
  });
  await t.test('final decision and unresolved topic remain separate', () => {
    const decision = result.summary.items.find(i => i.kind === 'decision' && /목요일/.test(i.text));
    assert.ok(decision, 'final Thursday decision must not remain a generic discussion');
    assert.match(decision.text, /취소|변경/);
    assert.ok(decision.evidence.some(e => e.segmentId === 'early'));
    assert.ok(decision.evidence.some(e => e.segmentId === 'late'));
    assert.ok(decision.evidence.every(e => e.segmentId !== 'long'), 'unspecified uncertainty must not support the schedule decision');
    assert.ok(result.summary.items.some(i => i.kind === 'topic' && /미정|결정/.test(i.text) &&
      i.evidence.some(e => e.segmentId === 'long')));
  });
  await page.evaluate(() => mergeClient.dispose());
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
});
