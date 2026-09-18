import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Qwen3 4B WebGPU summarizes Korean synthetic transcript from local assets', { timeout: 240000 }, async t => {
  assert.ok(process.env.OMN_SUMMARY_FIXTURE, 'Set OMN_SUMMARY_FIXTURE to prepared local model directory');
  const root = await mkdtemp(join(tmpdir(), 'omn-summary-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  page.on('console', message => { if (message.text().startsWith('model-progress:')) t.diagnostic(message.text()); });
  const result = await page.evaluate(async () => {
    const attempts = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const raw = typeof args[0] === 'string' ? args[0] : args[0].url ?? String(args[0]);
      const url = new URL(raw, location.href);
      if (url.protocol !== 'omn:' || url.host !== 'app') { attempts.push(url.href); throw new Error('external fetch denied'); }
      return originalFetch(...args);
    };
    const { loadSummarizer } = await import('/summarizer.mjs');
    let progress = -1;
    const model = await loadSummarizer({ onProgress: event => {
      const step = Math.floor(event.progress * 4);
      if (step > progress) { progress = step; console.log(`model-progress:${step}/4`); }
    } });
    try {
      const summary = await model.summarize({ revision: 1, segments: [
        { id: 's1', rawText: '민수: 보고서는 제가 금요일까지 작성하겠습니다.' },
        { id: 's2', rawText: '지현: 고객 미팅은 화요일로 확정했습니다.' },
        { id: 's3', rawText: '민수: 예산 증액은 이번 회의에서 결정하지 않았습니다.' }
      ] });
      return { summary, attempts };
    } finally { await model.dispose(); }
  });
  await writeFile(join(process.env.OMN_SUMMARY_FIXTURE, 'last-test-result.json'), JSON.stringify(result, null, 2));
  t.diagnostic(JSON.stringify(result.summary));
  assert.deepEqual(result.attempts, []);
  assert.equal(result.summary.revision, 1);
  assert.ok(result.summary.items.some(i => i.kind === 'action' && i.evidence.some(e => e.segmentId === 's1')));
  assert.ok(result.summary.items.some(i => i.kind === 'decision' && i.evidence.some(e => e.segmentId === 's2')));
  assert.ok(!result.summary.items.some(i => i.kind === 'decision' && i.evidence.some(e => e.segmentId === 's3')));
});
