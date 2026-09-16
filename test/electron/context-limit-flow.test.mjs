import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';
import { analyzeRecording } from '../../src/analyze-recording.mjs';

test('real context overflow crosses Worker/UI/Main and preserves cached transcript and parts', { timeout: 180000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-context-flow-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const models = await page.evaluate(() => window.meeting.models()); assert.equal(models.error, null);
  const id = '44444444-4444-4444-8444-444444444444', root = join(directory, 'recordings', id);
  const store = new ChunkStore(root);
  await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 0, startFrame: 0,
    frames: 160, sampleRate: 16000, channels: 1 }, Buffer.alloc(320));
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 160, remote: 0 } });
  const quote = '아직 결정하지 않았습니다.', text = `${quote} `.repeat(1000);
  // Seed synthetic STT, partition and summary results through their real validators.
  // The actual model handles the oversized reconciliation request, not STT/summary quality here.
  const seeded = await analyzeRecording({ root, models, execute: async (operation, input) => {
    if (operation === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone',
      start: 0, end: .01, rawText: text, flags: [] }];
    if (operation === 'plan-summary') return [text.slice(0, 7500), text.slice(7500)].map(rawText => ({ revision: 1,
      segments: [{ id: input.transcript.segments[0].id, rawText }] }));
    if (operation === 'summarize') return { version: 1, revision: 1, items: [{ kind: 'topic', status: 'candidate',
      text: '아직 미정', evidence: [{ segmentId: input.transcript.segments[0].id, quote }] }] };
    throw new Error('leave reconciliation for real model');
  } });
  assert.equal(seeded.summaryParts.state, 'complete'); assert.equal(seeded.reconciliation.state, 'failed');
  const records = async () => Promise.all((await readdir(join(root, 'jobs'))).sort().map(async name =>
    [name, await readFile(join(root, 'jobs', name), 'utf8')]));
  const before = await records();
  await page.evaluate(() => {
    globalThis.operations = [];
    window.meeting.onInferenceRequest(message => operations.push(message.operation));
  });
  await page.getByRole('button', { name: '목록 새로고침' }).click();
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.getByRole('button', { name: '전사·요약', exact: true }).click();
    await page.locator('#analysis-export').waitFor({ state: 'visible', timeout: 120000 });
    assert.match(await page.locator('#analysis-status').innerText(), /모델 입력 한도를 넘었습니다/);
    assert.match(await page.locator('#analysis-status').innerText(), /구간 요약은 보존/);
    assert.equal(await page.locator('.review-choice').count(), 2);
    assert.match(await page.locator('#transcript').innerText(), /아직 결정하지 않았습니다/);
    assert.deepEqual(await page.evaluate(() => operations), Array(attempt).fill('reconcile'));
    assert.deepEqual(await records(), before, 'overflow must not alter committed jobs or cache a failed result');
  }
  await page.getByRole('button', { name: 'Markdown 저장' }).click();
  await page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }).waitFor();
  const path = (await page.locator('#export-status').innerText()).replace('이 기기에 저장했습니다: ', '');
  const markdown = await readFile(path, 'utf8');
  assert.match(markdown, /요약 미완료/); assert.match(markdown, /아직 결정하지 않았습니다/);
  assert.doesNotMatch(markdown, /통합 요약 완료/);
  assert.deepEqual(errors, []); assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
  t.diagnostic(JSON.stringify({ characters: text.length, operations: await page.evaluate(() => operations),
    committedJobsUnchanged: true, exportIncomplete: true }));
});
