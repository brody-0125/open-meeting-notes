import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('analysis shows recorded pauses separately and clears them for the next analysis', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omn-pause-analysis-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => {
    const { renderAnalysis } = await import('/analysis.mjs');
    globalThis.pausedResult = { transcript: { revision: 1, segments: [
      { source: 'microphone', start: 1, end: 2, rawText: '검토를 시작합니다.' }
    ], pauses: [
      { pauseId: 1, source: 'microphone', start: 2, end: 15.5 },
      { pauseId: 1, source: 'remote', start: 2.01, end: 15.51 },
      { pauseId: 2, source: 'microphone', start: 20, end: null }
    ] }, summary: { items: [{ kind: 'topic', text: '검토를 시작합니다.', evidence: [{ quote: '검토를 시작합니다.' }] }] } };
    document.getElementById('analysis').hidden = false;
    renderAnalysis(pausedResult);
  });
  const panel = page.locator('#analysis-pauses');
  await panel.waitFor({ state: 'visible', timeout: 2000 });
  assert.match(await panel.innerText(), /전사·요약에 포함되지 않습니다/);
  assert.match(await panel.innerText(), /마이크 · 2\.000–15\.500초/);
  assert.match(await panel.innerText(), /공유 오디오 · 2\.010–15\.510초/);
  assert.match(await panel.innerText(), /20\.000초부터 재개 없이 녹음 종료/);
  assert.equal(await page.locator('#transcript li').count(), 1);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const screenshots = fileURLToPath(new URL('../../../../work/app-qa/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.locator('#analysis').screenshot({ path: join(screenshots, 'analysis-pauses.png') });
  await page.evaluate(async () => {
    const { renderAnalysis } = await import('/analysis.mjs');
    const result = structuredClone(pausedResult); delete result.transcript.pauses; renderAnalysis(result);
  });
  assert.equal(await panel.isHidden(), true); assert.equal(await panel.locator('li').count(), 0);
  await page.evaluate(async () => {
    const { renderAnalysis, analyze } = await import('/analysis.mjs');
    renderAnalysis(pausedResult); await analyze('missing-recording');
  });
  assert.equal(await panel.isHidden(), true); assert.equal(await panel.locator('li').count(), 0);
  assert.deepEqual(errors, []);
});
