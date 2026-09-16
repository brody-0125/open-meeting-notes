import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('UI presents reconciled candidates and preserves per-part results on reconciliation failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omn-reconciliation-ui-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.evaluate(async () => {
    const { renderAnalysis } = await import('/analysis.mjs');
    document.getElementById('analysis').hidden = false;
    const item = text => ({ kind: 'decision', text, status: 'candidate', evidence: [{ segmentId: 's', quote: '목요일에 엽니다.' }] });
    globalThis.fixture = { transcript: { revision: 1, segments: [{ id: 's', source: 'microphone', start: 0, rawText: '목요일에 엽니다.' }] },
      summary: { items: [item('통합된 목요일 결정')] }, reconciliation: { state: 'complete' }, reviews: [['candidate']],
      summaryParts: { state: 'complete', total: 2, parts: [0, 1].map(index => ({ index, summary: { items: [item(`이전 후보 ${index}`)] } })) } };
    renderAnalysis(globalThis.fixture);
  });
  assert.match(await page.locator('#analysis-status').innerText(), /통합 요약 완료/);
  assert.match(await page.locator('#summary').innerText(), /통합된 목요일 결정/);
  assert.doesNotMatch(await page.locator('#summary').innerText(), /이전 후보/);
  assert.equal(await page.locator('.review-choice').count(), 1);
  await page.evaluate(async () => {
    const { renderAnalysis } = await import('/analysis.mjs');
    fixture.reconciliation.state = 'failed'; fixture.summary = null; fixture.summaryError = 'context budget'; fixture.summaryErrorCode = 'CONTEXT_LIMIT';
    fixture.reviews = [['candidate'], ['candidate']]; renderAnalysis(fixture);
  });
  assert.match(await page.locator('#analysis-status').innerText(), /통합을 완료하지 못/);
  assert.match(await page.locator('#analysis-status').innerText(), /모델 입력 한도/);
  assert.match(await page.locator('#summary').innerText(), /이전 후보 0/);
  assert.equal(await page.locator('.review-choice').count(), 2);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});
