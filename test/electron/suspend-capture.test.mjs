import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { inspectRecording } from '../../src/recording-seal.mjs';
import { ChunkStore } from '../../src/store.mjs';

async function launchApp(t) {
  const root = await mkdtemp(join(tmpdir(), 'omn-suspend-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: root } });
  t.after(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
    try { await app.close(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, app, page: await app.firstWindow() };
}

for (const pending of ['display', 'microphone']) test(`suspend during ${pending} selection releases late input without recording`, { timeout: 20000 }, async t => {
  const { root, app, page } = await launchApp(t);
  await page.evaluate(pending => {
    globalThis.selectionContext = new AudioContext();
    globalThis.remoteInput = selectionContext.createMediaStreamDestination().stream;
    globalThis.microphoneInput = selectionContext.createMediaStreamDestination().stream;
    globalThis.microphoneRequests = 0;
    navigator.mediaDevices.getDisplayMedia = () => pending === 'display'
      ? new Promise(resolve => { globalThis.grantLate = () => resolve(remoteInput); }) : Promise.resolve(remoteInput);
    navigator.mediaDevices.getUserMedia = () => {
      microphoneRequests++;
      return pending === 'microphone' ? new Promise(resolve => { globalThis.grantLate = () => resolve(microphoneInput); }) : Promise.resolve(microphoneInput);
    };
  }, pending);
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인', exact: true }).click();
  await page.waitForFunction(() => typeof grantLate === 'function');
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); powerMonitor.emit('resume'); });
  await page.getByText('녹음 대기', { exact: true }).waitFor({ timeout: 3000 });
  if (pending === 'microphone') assert.equal(await page.evaluate(() => remoteInput.getTracks().every(t => t.readyState === 'ended')), true);
  await page.evaluate(() => grantLate());
  await page.waitForFunction(pending => (pending === 'display' ? remoteInput : microphoneInput).getTracks().every(t => t.readyState === 'ended'), pending);
  assert.equal(await page.evaluate(() => microphoneRequests), pending === 'display' ? 0 : 1);
  assert.equal(await page.locator('body').getAttribute('data-state'), 'idle');
  assert.deepEqual(await readdir(join(root, 'recordings')), []);
  await page.evaluate(async () => {
    for (const stream of [remoteInput, microphoneInput]) stream.getTracks().forEach(track => track.stop());
    await selectionContext.close();
  });
});

test('approval arriving after suspend is discarded; a fresh request still requires approval', { timeout: 20000 }, async t => {
  const { root, app, page } = await launchApp(t);
  await app.evaluate(() => { globalThis.testConfirm = () => new Promise(resolve => { globalThis.resolveApproval = resolve; }); });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByText('녹음 승인 대기', { exact: true }).waitFor();
  await app.evaluate(({ powerMonitor }) => {
    if (!globalThis.resolveApproval) throw new Error('approval not pending');
    powerMonitor.emit('suspend'); powerMonitor.emit('resume'); globalThis.resolveApproval(true);
  });
  await page.getByText('녹음 대기', { exact: true }).waitFor({ timeout: 3000 });
  assert.deepEqual(await readdir(join(root, 'recordings')), []);
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByText('녹음 승인 대기', { exact: true }).waitFor();
  await app.evaluate(() => globalThis.resolveApproval(true));
  await page.getByRole('button', { name: '입력 선택 및 확인', exact: true }).waitFor();
});

test('system suspend fails active capture, releases inputs and never auto-resumes or seals', { timeout: 20000 }, async t => {
  const { root, app, page } = await launchApp(t);
  await page.evaluate(() => {
    const context = new AudioContext(); globalThis.testTracks = [];
    const input = () => {
      const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); testTracks.push(...destination.stream.getTracks()); return destination.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => { await context.resume(); return input(); };
    navigator.mediaDevices.getUserMedia = async () => input();
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인', exact: true }).click();
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForTimeout(1200);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await page.getByText('녹음이 완료되지 않았습니다', { exact: true }).waitFor({ timeout: 5000 });
  assert.match(await page.locator('#message').innerText(), /절전/);
  assert.equal(await page.evaluate(() => testTracks.length === 2 && testTracks.every(track => track.readyState === 'ended')), true);
  const ids = await readdir(join(root, 'recordings')); assert.equal(ids.length, 1);
  const recordingRoot = join(root, 'recordings', ids[0]);
  assert.equal((await inspectRecording(recordingRoot)).state, 'incomplete');
  const index = await new ChunkStore(recordingRoot).index();
  assert.deepEqual(index.errors, []); assert.ok(index.chunks.length >= 2);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  assert.equal(await page.locator('body').getAttribute('data-state'), 'failed');
  assert.equal((await inspectRecording(recordingRoot)).state, 'incomplete');
  await page.getByRole('button', { name: '새 녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인', exact: true }).waitFor();
});
