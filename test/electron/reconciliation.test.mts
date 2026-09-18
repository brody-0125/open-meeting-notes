import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconciliationInput, validateReconciliation } from '../../src/inference/reconciliation.mjs';
import { validateReconciliationPlan } from '../../src/inference/reconciliation-plan.mjs';

test('local Qwen reconciles a Korean cancellation with provenance and rejects oversized complete input', { timeout: 180000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-reconcile-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const transcript = { revision: 3, segments: [
    { id: 'early', rawText: '회의는 화요일에 엽니다.' },
    { id: 'late', rawText: '화요일 결정을 취소합니다. 목요일에 엽니다.' }
  ] };
  const input = reconciliationInput(transcript, { state: 'complete', total: 2,
    parts: transcript.segments.map((s, index) => ({ index, summary: { version: 1, revision: 3, items: [{
      kind: 'decision', text: s.rawText, status: 'candidate', evidence: [{ segmentId: s.id, quote: s.rawText }]
    }] } })) });
  const page = await app.firstWindow();
  const actual = await page.evaluate(async input => {
    const models = await window.meeting.models();
    if (models.error || !models.summary) throw new Error(JSON.stringify(models));
    const { InferenceClient } = await import('/inference-client.mjs');
    let workersCreated = 0;
    const client = new InferenceClient(() => { workersCreated++; return new Worker('omn://app/inference-worker.mjs', { type: 'module' }); });
    try {
      const result = await client.run('reconcile', { modelHash: models.summary.modelHash, reconciliation: input });
      const classification = await client.run('summarize', { modelHash: models.summary.modelHash, transcript: { revision: 1, segments: [
        { id: 'promise', rawText: '민수: 보고서는 제가 금요일까지 작성하겠습니다.' },
        { id: 'decided', rawText: '지현: 고객 미팅은 화요일로 확정했습니다.' },
        { id: 'undecided', rawText: '민수: 예산 증액은 이번 회의에서 결정하지 않았습니다.' }
      ] } });
      const long = structuredClone(input);
      long.transcript.push({ id: 'long', rawText: '아직 결정하지 않았습니다. '.repeat(1000) });
      const longTranscript = { revision: long.revision, segments: long.transcript };
      let oversizedError, oversizedCode;
      try { await client.run('reconcile', { modelHash: models.summary.modelHash, reconciliation: long }); }
      catch (error) { oversizedError = error.message; oversizedCode = error.code; }
      const plan = await client.run('plan-reconciliation', { modelHash: models.summary.modelHash, transcript: longTranscript });
      return { result, oversizedError, oversizedCode, workersCreated, classification, plan, longTranscript };
    } finally { client.dispose(); }
  }, input);
  const summary = validateReconciliation(actual.result, input);
  const text = summary.items.map(item => item.text).join(' ');
  assert.match(text, /목요일/);
  assert.match(text, /취소|변경/);
  // Both candidates describe one revised decision; a new discussion/question is invented.
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].kind, 'decision');
  assert.deepEqual(new Set(actual.result.items[0].candidateIds), new Set(['p0:i0', 'p1:i0']));
  assert.doesNotMatch(text, /[?？]|적절한가/);
  assert.match(actual.oversizedError, /context budget/);
  assert.equal(actual.oversizedCode, 'CONTEXT_LIMIT');
  assert.equal(actual.workersCreated, 1);
  validateReconciliationPlan(actual.plan, actual.longTranscript);
  assert.ok(actual.plan.parts.length > 1);
  assert.ok(actual.classification.items.some(i => i.kind === 'action' && i.evidence.some(e => e.segmentId === 'promise')));
  assert.ok(actual.classification.items.some(i => i.kind === 'decision' && i.evidence.some(e => e.segmentId === 'decided')));
  assert.ok(actual.classification.items.some(i => i.kind === 'topic' && i.evidence.some(e => e.segmentId === 'undecided')));
  assert.ok(!actual.classification.items.some(i => i.kind === 'decision' && i.evidence.some(e => e.segmentId === 'undecided')));
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
  // A single golden case is a regression smoke, not a general semantic quality gate.
  const { plan, longTranscript, ...small } = actual;
  t.diagnostic(JSON.stringify({ ...small, plannedParts: plan.parts.length,
    originalCharacters: longTranscript.segments.reduce((n, s) => n + s.rawText.length, 0) }));
});
