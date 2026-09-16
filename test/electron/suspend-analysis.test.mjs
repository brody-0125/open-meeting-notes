import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording, inspectRecording } from '../../src/recording-seal.mjs';
import { analyzeRecording } from '../../src/analyze-recording.mjs';

for (const operation of ['transcribe', 'summarize']) test(`suspend cancels pending ${operation}, preserves committed work and permits explicit retry`, { timeout: 60000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-suspend-analysis-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const models = await page.evaluate(() => window.meeting.models());
  assert.equal(models.error, null);
  const id = '44444444-4444-4444-8444-444444444444', root = join(directory, 'recordings', id);
  const store = new ChunkStore(root);
  await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 0, startFrame: 0,
    frames: 160, sampleRate: 16000, channels: 1 }, Buffer.alloc(320));
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 160, remote: 0 } });
  if (operation === 'summarize') await analyzeRecording({ root, models, execute: async (op, input) => {
    if (op === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone',
      start: 0, end: .01, rawText: '아직 결정하지 않았습니다.', flags: [] }];
    if (op === 'plan-summary') return [input.transcript];
    throw new Error('leave summary pending for lifecycle test');
  } });
  const committed = async () => {
    const names = await readdir(join(root, 'jobs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    return Promise.all(names.sort().map(async name => [name, await readFile(join(root, 'jobs', name), 'utf8')]));
  };
  const before = await committed();
  // Hold the computation at the real UI/Main boundary; this tests lifecycle, not model quality.
  await page.evaluate(() => {
    globalThis.workers = []; globalThis.requests = [];
    globalThis.Worker = class {
      constructor() { workers.push(this); this.terminated = false; }
      postMessage(message) { this.message = message; }
      terminate() { this.terminated = true; }
    };
    window.meeting.onInferenceRequest(message => requests.push(message));
  });
  await page.getByRole('button', { name: '목록 새로고침' }).click();
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.getByRole('button', { name: '전사·요약', exact: true }).click();
    await page.waitForFunction(n => workers.length === n && workers[n - 1].message, attempt);
    assert.deepEqual(await page.evaluate(() => requests.map(r => r.operation)), Array(attempt).fill(operation));
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); powerMonitor.emit('resume'); });
    await page.locator('#analysis-status').filter({ hasText: '분석을 완료하지 못했습니다' }).waitFor({ timeout: 3000 });
    assert.equal(await page.locator('#analysis-export').isVisible(), false);
    assert.equal(await page.evaluate(() => workers.every(w => w.terminated)), true);
    assert.equal(await page.evaluate(() => window.meeting.inferenceResult({ ...requests.at(-1), result: [] })), false);
    assert.deepEqual(await committed(), before);
    assert.equal((await inspectRecording(root)).state, 'complete');
    assert.equal(await page.evaluate(() => requests.length), attempt, 'resume must not restart analysis');
  }
});
