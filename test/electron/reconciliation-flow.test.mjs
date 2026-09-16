import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';
import { analyzeRecording } from '../../src/analyze-recording.mjs';

test('Main → real partition summaries → reconciliation → review/export → cached replay', { timeout: 240000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-reconciliation-flow-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const models = await page.evaluate(() => window.meeting.models());
  assert.equal(models.error, null);
  const id = '33333333-3333-4333-8333-333333333333', root = join(directory, 'recordings', id);
  const store = new ChunkStore(root);
  await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 0, startFrame: 0,
    frames: 160, sampleRate: 16000, channels: 1 }, Buffer.alloc(320));
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 160, remote: 0 } });
  const phrases = ['회의는 화요일에 엽니다. ', '화요일 결정을 취소합니다. 목요일에 엽니다.'];
  // Synthetic STT/partition fixtures only. No microphone access and no claim of STT accuracy.
  // Seed through the real job writer so the product revalidates cached inputs normally.
  const seeded = await analyzeRecording({ root, models, execute: async (operation, input) => {
    if (operation === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone',
      start: 0, end: .01, rawText: phrases.join(''), flags: [] }];
    if (operation === 'plan-summary') return phrases.map(rawText => ({ revision: 1,
      segments: [{ id: input.transcript.segments[0].id, rawText }] }));
    throw new Error('leave generation for the actual local model');
  } });
  assert.equal(seeded.summaryParts.state, 'partial');
  assert.equal(seeded.summaryParts.parts.length, 0);
  await page.evaluate(() => {
    globalThis.operations = [];
    window.meeting.onInferenceRequest(message => operations.push(message.operation));
  });
  await page.getByRole('button', { name: '목록 새로고침' }).click();
  const analyze = page.getByRole('button', { name: '전사·요약', exact: true });
  await analyze.click();
  await page.locator('#analysis-export').waitFor({ state: 'visible', timeout: 180000 });
  const status = await page.locator('#analysis-status').innerText();
  assert.match(status, /통합 요약 완료/, status);
  const summaryText = await page.locator('#summary').innerText();
  // Synthetic fixture only: retain intermediate outputs for diagnosing error propagation.
  const generations = [];
  for (const name of await readdir(join(root, 'jobs'))) if (name.endsWith('.json')) {
    const record = JSON.parse(await readFile(join(root, 'jobs', name), 'utf8'));
    if (['summarize', 'reconcile'].includes(record.descriptor.kind)) generations.push({ kind: record.descriptor.kind, result: record.result });
  }
  t.diagnostic(JSON.stringify({ generations }));
  assert.match(summaryText, /목요일/); assert.match(summaryText, /취소|변경/);
  assert.doesNotMatch(summaryText, /[?？]|적절한가/);
  assert.equal(await page.locator('.review-choice').count(), 1);
  assert.ok(await page.locator('#summary blockquote').count() >= 2);
  assert.deepEqual(await page.evaluate(() => operations), ['summarize', 'summarize', 'reconcile']);
  await page.locator('.review-choice').selectOption('accepted');
  await page.getByText('검토 판단을 이 기기에 저장했습니다.').waitFor();
  await analyze.click();
  await page.locator('#analysis-export').waitFor({ state: 'visible' });
  assert.match(await page.locator('#analysis-status').innerText(), /통합 요약 완료/);
  assert.equal(await page.locator('.review-choice').inputValue(), 'accepted');
  assert.deepEqual(await page.evaluate(() => operations), ['summarize', 'summarize', 'reconcile']);
  await page.getByRole('button', { name: 'Markdown 저장' }).click();
  await page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }).waitFor();
  const path = (await page.locator('#export-status').innerText()).replace('이 기기에 저장했습니다: ', '');
  assert.equal(dirname(path), join(directory, 'exports'));
  const markdown = await readFile(path, 'utf8');
  assert.match(markdown, /통합 요약 완료/); assert.match(markdown, /사용자 채택/);
  assert.match(markdown, /목요일/); assert.doesNotMatch(markdown, /통합되지 않았/);
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
  assert.deepEqual(errors, []);
  const screenshots = fileURLToPath(new URL('../../../../work/app-qa/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshots, 'reconciliation-flow.png'), fullPage: true });
  t.diagnostic(JSON.stringify({ status, summaryText, operations: await page.evaluate(() => operations) }));
  // This fixture explicitly changes a decision; don't accept an unresolved topic.
  assert.match(summaryText, /통합 · 결정/);
});
