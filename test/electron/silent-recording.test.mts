import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';

test('sealed digital silence produces no transcript evidence or summary calls in the real app', { timeout: 60000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-silent-recording-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), id = '44444444-4444-4444-8444-444444444444';
  assert.equal((await page.evaluate(() => window.meeting.models())).error, null);
  const store = new ChunkStore(join(directory, 'recordings', id));
  for (const source of ['microphone', 'remote']) await store.put({ version: 1, sessionId: id, epoch: 0,
    source, seq: 0, startFrame: 0, frames: 96000, sampleRate: 48000, channels: 1 }, Buffer.alloc(192000));
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 96000, remote: 96000 } });
  await page.evaluate(() => {
    globalThis.operations = [];
    window.meeting.onInferenceRequest(message => operations.push(message.operation));
  });
  await page.getByRole('button', { name: '목록 새로고침' }).click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '전사·요약', exact: true }).click();
    await page.locator('#analysis-export').waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('#transcript li').count(), 0);
    assert.equal(await page.locator('#summary blockquote').count(), 0);
    assert.deepEqual(await page.evaluate(() => operations), ['transcribe', 'transcribe']);
  }
  await page.getByRole('button', { name: 'Markdown 저장' }).click();
  const status = page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }); await status.waitFor();
  const path = (await status.innerText()).replace('이 기기에 저장했습니다: ', '');
  assert.match(await readFile(path, 'utf8'), /상태: 요약 없음/);
});
