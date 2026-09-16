import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';

test('preview UI plays verified PCM, stops on user action and suspend, and renders on narrow screens', { timeout: 60000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-playback-ui-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_VAD_FIXTURE: '', OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  assert.equal(page.url(), 'omn://app/index.html'); assert.equal(await page.title(), 'open-meeting-notes');
  await page.getByRole('heading', { name: '회의를 기록하세요.' }).waitFor();
  const id = '88888888-8888-4888-8888-888888888888', store = new ChunkStore(join(directory, 'recordings', id));
  const pcm = Buffer.alloc(160000);
  for (let i = 0; i < 80000; i++) pcm.writeInt16LE(Math.round(500 * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2);
  await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 0,
    startFrame: 0, frames: 80000, sampleRate: 16000, channels: 1 }, pcm);
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 80000, remote: 0 } });
  await page.evaluate(() => {
    // Model substitution only. Main lookup, stored audio and Web Audio are real.
    globalThis.Worker = class {
      postMessage({ id, input }) {
        queueMicrotask(() => this.onmessage?.({ data: { id, type: 'result', result: [{
          id: `${input.audio.jobId}:0`, jobId: input.audio.jobId, source: 'microphone', start: 0, end: 5,
          rawText: '원음 검토를 위한 합성 입력입니다.', flags: []
        }] } }));
      }
      terminate() {}
    };
    const NativeContext = AudioContext; globalThis.previewContexts = [];
    globalThis.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args); previewContexts.push(this);
        const original = this.createBufferSource.bind(this);
        this.createBufferSource = () => {
          const node = original(), connect = node.connect.bind(node);
          // Test output is muted; this does not claim physical speaker audibility.
          node.connect = destination => { const gain = this.createGain(); gain.gain.value = 0; connect(gain); gain.connect(destination); };
          return node;
        };
      }
    };
  });
  await page.getByRole('button', { name: '목록 새로고침' }).click();
  await page.getByRole('button', { name: '전사·요약', exact: true }).click();
  await page.locator('#analysis-export').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '원음 재생', exact: true }).click();
  await page.getByRole('button', { name: '재생 중지', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => previewContexts.at(-1).state), 'running');
  const screenshots = fileURLToPath(new URL('../../../quality/playback/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true });
  await page.locator('#analysis').screenshot({ path: join(screenshots, 'controls.png') });
  await page.getByRole('button', { name: '재생 중지', exact: true }).click();
  await page.waitForFunction(() => previewContexts.every(c => c.state === 'closed'));
  await page.setViewportSize({ width: 390, height: 760 });
  await page.getByRole('button', { name: '원음 재생', exact: true }).click();
  await page.getByRole('button', { name: '재생 중지', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshots, 'narrow.png'), fullPage: true });
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await page.getByRole('button', { name: '원음 재생', exact: true }).waitFor();
  await page.waitForFunction(() => previewContexts.every(c => c.state === 'closed'));
  await page.getByRole('button', { name: '원음 재생', exact: true }).click();
  await page.getByRole('button', { name: '재생 중지', exact: true }).waitFor();
  await page.getByRole('button', { name: '전사·요약', exact: true }).click();
  await page.locator('#analysis-export').waitFor({ state: 'visible' });
  await page.waitForFunction(() => previewContexts.every(c => c.state === 'closed'));
  await page.getByRole('button', { name: '원음 재생', exact: true }).click();
  await page.getByRole('button', { name: '재생 중지', exact: true }).waitFor();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByText('녹음 준비를 취소했습니다.', { exact: true }).waitFor();
  await page.waitForFunction(() => previewContexts.every(c => c.state === 'closed'));
  assert.deepEqual(errors, []);
});
