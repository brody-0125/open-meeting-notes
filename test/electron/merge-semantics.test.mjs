import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore } from '../../src/jobs.mjs';
import { mergeScannedWindows } from '../../src/reconciliation-merge.mjs';

// Frozen synthetic checks for the merge stage, independent of the repeated-text
// case used while developing it. These do not evaluate STT or the source scanner.
const cases = [
  { id: 'promise', lines: ['민수: 금요일까지 계약서 초안을 보내겠습니다.', '수신 담당자는 아직 정하지 않았습니다.'], check(items) {
    assert.ok(items.some(i => i.kind === 'action' && /금요일/.test(i.text) && i.evidence.some(e => e.segmentId === 's0')));
    assert.ok(items.some(i => i.kind === 'topic' && i.evidence.some(e => e.segmentId === 's1')));
  } },
  { id: 'two-revisions', lines: ['배포는 월요일로 확정합니다.', '월요일 배포를 취소하고 수요일 배포로 확정합니다.',
    '수요일도 취소하고 금요일 배포로 확정합니다.'], check(items) {
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'decision'); assert.match(items[0].text, /금요일/); assert.match(items[0].text, /취소|변경/);
    assert.deepEqual(new Set(items[0].evidence.map(e => e.segmentId)), new Set(['s0', 's1', 's2']));
  } },
  { id: 'proposal', lines: ['서버를 교체하면 어떨까요?', '서버 교체는 제안일 뿐이며 아직 승인하지 않았습니다.'], check(items) {
    assert.ok(items.length > 0); assert.ok(items.every(i => i.kind === 'topic'));
  } },
  { id: 'separate-topics', lines: ['외부 공개는 오늘 오후로 확정합니다.', '예산 증액은 아직 정하지 않았습니다.'], check(items) {
    assert.ok(items.some(i => i.kind === 'decision' && /공개/.test(i.text) && i.evidence.some(e => e.segmentId === 's0')));
    assert.ok(items.some(i => i.kind === 'topic' && /예산/.test(i.text) && i.evidence.some(e => e.segmentId === 's1')));
  } }
];

// Additional development cases: distinguish an unspecified subject from an
// explicit reference. The original four expectations above remain unchanged.
cases.push(
  { id: 'unspecified-subject', lines: ['행사는 토요일로 확정했습니다.', '아직 검토 중입니다.', '토요일 행사를 취소하고 일요일에 진행하기로 했습니다.'], check(items) {
    const decision = items.find(i => i.kind === 'decision' && /일요일/.test(i.text));
    assert.ok(decision); assert.match(decision.text, /취소|변경/);
    assert.deepEqual(new Set(decision.evidence.map(e => e.segmentId)), new Set(['s0', 's2']));
    assert.ok(items.some(i => i.kind === 'topic' && i.evidence.some(e => e.segmentId === 's1')));
  } },
  { id: 'explicit-reference', lines: ['납품일은 10일로 확정합니다.', '그 납품일은 취소하고 12일로 변경하기로 합의했습니다.'], check(items) {
    assert.equal(items.length, 1); assert.equal(items[0].kind, 'decision');
    assert.match(items[0].text, /12일/); assert.match(items[0].text, /취소|변경/);
    assert.deepEqual(new Set(items[0].evidence.map(e => e.segmentId)), new Set(['s0', 's1']));
  } }
);

test('local excerpt merge preserves actions, revisions, proposals and separate unresolved topics', { timeout: 300000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-merge-semantics-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const model = await page.evaluate(async () => {
    const { InferenceClient } = await import('/inference-client.mjs');
    globalThis.semanticClient = new InferenceClient();
    const models = await window.meeting.models();
    if (models.error || !models.summary) throw new Error(JSON.stringify(models));
    return models.summary;
  });
  const modelHash = model.modelHash;
  const strategy = process.env.OMN_MERGE_STRATEGY ?? 'direct';
  t.diagnostic(JSON.stringify({ model, strategy, cases: cases.length }));
  for (const fixture of cases) await t.test(fixture.id, async () => {
    const transcript = { revision: 1, segments: fixture.lines.map((rawText, i) => ({ id: `s${i}`, rawText })) };
    const scan = { state: 'scanned', totalWindows: fixture.lines.length, leaves: transcript.segments.map((s, index) => ({
      index, path: '', segments: [{ ...s, start: 0, end: s.rawText.length }], result: { version: 1, revision: 1, items: [{
        kind: 'topic', text: '분류는 원문에서 다시 판단한다.', status: 'candidate', candidateIds: [], evidence: [{ segmentId: s.id, quote: s.rawText }]
      }] }
    })) };
    const result = await mergeScannedWindows({ jobs: new JobStore(join(directory, 'jobs')),
      descriptor: { version: 1, sessionId: fixture.id, kind: 'reconcile', revision: 1,
        inputHash: 'a'.repeat(64), settingsHash: 'b'.repeat(64), modelHash }, transcript, scan, strategy,
      execute: (operation, input) => page.evaluate(({ operation, input }) => semanticClient.run(operation, input), { operation, input }) });
    t.diagnostic(JSON.stringify({ case: fixture.id, summary: result.summary, groupPlan: result.groupPlan }));
    fixture.check(result.summary.items);
  });
  await page.evaluate(() => semanticClient.dispose());
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
});
