import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { inspectRecording } from '../../src/recording-seal.mjs';

for (const failureStage of ['written', 'renamed']) test(`storage failure after ${failureStage} stops inputs, preserves audio, and permits a fresh session`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omn-storage-failure-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {});
    await app.close(); await rm(directory, { recursive: true, force: true });
  });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate((_, failureStage) => {
    const original = testChunkStore.prototype.commit;
    let count = 0;
    testChunkStore.prototype.commit = async function (...args) {
      if (++count !== 2) return original.apply(this, args);
      globalThis.failedStore = this;
      const checkpoint = this.checkpoint;
      this.checkpoint = async stage => {
        await checkpoint(stage);
        if (stage === failureStage) throw Object.assign(new Error('ENOSPC: synthetic storage failure'), { code: 'ENOSPC' });
      };
      try { return await original.apply(this, args); }
      finally { this.checkpoint = checkpoint; testChunkStore.prototype.commit = original; }
    };
  }, failureStage);
  await page.evaluate(() => {
    globalThis.testStreams = [];
    const context = globalThis.testAudio = new AudioContext();
    const input = async frequency => {
      await context.resume();
      const oscillator = new OscillatorNode(context, { frequency });
      const output = context.createMediaStreamDestination();
      oscillator.connect(output); oscillator.start(); testStreams.push(output.stream); return output.stream;
    };
    navigator.mediaDevices.getDisplayMedia = () => input(440);
    navigator.mediaDevices.getUserMedia = () => input(880);
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.getByText('녹음이 완료되지 않았습니다', { exact: true }).waitFor();
  await page.waitForFunction(() => testStreams.length === 2 && testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
  assert.match(await page.locator('#message').innerText(), /ENOSPC/);
  assert.equal(await page.getByText('녹음 저장 완료', { exact: true }).count(), 0);
  await app.evaluate(async () => { await failedStore.pending; });
  const [failedId] = await readdir(join(directory, 'recordings'));
  const failedRoot = join(directory, 'recordings', failedId);
  const index = await new ChunkStore(failedRoot).index();
  assert.ok(index.chunks.length >= (failureStage === 'written' ? 1 : 2));
  assert.equal(index.partials.length, failureStage === 'written' ? 1 : 0); assert.deepEqual(index.errors, []);
  assert.equal((await inspectRecording(failedRoot)).state, 'incomplete');
  assert.equal((await readdir(failedRoot)).includes('complete.json'), false);
  await page.getByRole('button', { name: '새 녹음 준비' }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: '녹음 종료' }).click();
  await page.getByText('녹음 저장 완료', { exact: true }).waitFor();
  const newIds = (await readdir(join(directory, 'recordings'))).filter(id => id !== failedId);
  assert.equal(newIds.length, 1);
  assert.equal((await inspectRecording(join(directory, 'recordings', newIds[0]))).state, 'complete');
  assert.deepEqual(await new ChunkStore(failedRoot).index(), index);
  assert.deepEqual(errors, []);
  await page.evaluate(() => testAudio.close());
});
