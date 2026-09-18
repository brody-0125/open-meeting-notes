import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRecording } from '../../src/recording-seal.mjs';
import { ChunkStore } from '../../src/store.mjs';

for (const operation of ['pause', 'resume']) for (const action of ['stop', 'suspend'])
test(`${action} during delayed ${operation} ACK cannot revive capture or lose committed audio`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omn-pause-race-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const context = new AudioContext(); globalThis.raceTracks = [];
    const source = () => {
      const oscillator = context.createOscillator(), output = context.createMediaStreamDestination();
      oscillator.connect(output); oscillator.start(); raceTracks.push(...output.stream.getTracks()); return output.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => { await context.resume(); return source(); };
    navigator.mediaDevices.getUserMedia = async () => source();
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForTimeout(150);
  if (operation === 'resume') {
    await page.getByRole('button', { name: '일시정지', exact: true }).click();
    await page.getByText('녹음 일시정지', { exact: true }).waitFor();
  }
  await app.evaluate((_, operation) => {
    const PauseStore = globalThis.testPauseStore, original = PauseStore.prototype[operation];
    globalThis.pauseCheckpoint = false;
    PauseStore.prototype[operation] = async function (...args) {
      const result = await original.apply(this, args);
      PauseStore.prototype[operation] = original;
      await new Promise(resolve => { globalThis.releasePauseAck = resolve; globalThis.pauseCheckpoint = true; });
      return result;
    };
  }, operation);
  await page.getByRole('button', { name: operation === 'pause' ? '일시정지' : '녹음 재개', exact: true }).click();
  let reached = false;
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(() => globalThis.pauseCheckpoint)) { reached = true; break; }
    await page.waitForTimeout(20);
  }
  assert.equal(reached, true);
  const [id] = await readdir(join(directory, 'recordings')), root = join(directory, 'recordings', id);
  const before = await new ChunkStore(root).index(); assert.ok(before.chunks.length >= 2);
  await page.evaluate(() => {
    globalThis.statesAfterStop = [];
    new MutationObserver(() => statesAfterStop.push(document.body.dataset.state))
      .observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  });
  if (action === 'stop') await page.getByRole('button', { name: '녹음 종료', exact: true }).click();
  else await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await app.evaluate(() => releasePauseAck());
  await page.waitForFunction(() => ['saved', 'failed'].includes(document.body.dataset.state));
  const expected = action === 'stop' ? 'saved' : 'failed';
  assert.equal(await page.locator('body').getAttribute('data-state'), expected);
  assert.ok((await page.evaluate(() => statesAfterStop)).every(state => ['draining', expected].includes(state)));
  await page.waitForFunction(() => raceTracks.every(track => track.readyState === 'ended'));
  const after = await new ChunkStore(root).index();
  for (const chunk of before.chunks) assert.ok(after.chunks.some(c => c.file === chunk.file && c.checksum === chunk.checksum));
  assert.equal((await inspectRecording(root)).state, action === 'stop' ? 'complete' : 'incomplete');
  assert.deepEqual(errors, []);
});
