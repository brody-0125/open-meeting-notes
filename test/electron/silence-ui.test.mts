import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRecording } from '../../src/recording-seal.mjs';

test('pause disposes VAD and resume starts fresh monitoring; stop while paused seals audio', { timeout: 45000 }, async t => {
  assert.ok(process.env.OMN_VAD_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-pause-vad-ui-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-vad-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !document.getElementById('silence-enabled').disabled);
  await page.evaluate(() => {
    const NativeWorker = Worker; globalThis.vadWorkers = []; globalThis.inputTracks = [];
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.terminated = false; vadWorkers.push(this); }
      terminate() { this.terminated = true; return super.terminate(); }
    };
    const context = new AudioContext();
    const source = () => {
      const output = context.createMediaStreamDestination(), oscillator = context.createOscillator(), gain = context.createGain();
      gain.gain.value = 0; oscillator.connect(gain).connect(output); oscillator.start();
      inputTracks.push(...output.stream.getTracks()); return output.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => { await context.resume(); return source(); };
    navigator.mediaDevices.getUserMedia = async () => source();
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('silence-status').textContent.startsWith('무음 감시 중'));
  for (let round = 0; round < 2; round++) {
    await page.getByRole('button', { name: '일시정지', exact: true }).click();
    await page.getByText('녹음 일시정지', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => vadWorkers.length > 0 && vadWorkers.every(w => w.terminated)), true);
    assert.equal(await page.evaluate(() => inputTracks.every(t => t.readyState === 'live')), true);
    assert.equal(await page.locator('#silence-extend').isHidden(), true);
    if (round === 0) {
      await page.getByRole('button', { name: '녹음 재개', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('silence-status').textContent.startsWith('무음 감시 중'));
      assert.equal(await page.evaluate(() => vadWorkers.length), 2);
      assert.equal(await page.evaluate(() => vadWorkers.at(-1).terminated), false);
    }
  }
  await page.getByRole('button', { name: '녹음 종료', exact: true }).click();
  await page.getByText('녹음 저장 완료', { exact: true }).waitFor();
  const [id] = await readdir(join(directory, 'recordings')), saved = await inspectRecording(join(directory, 'recordings', id));
  assert.equal(saved.state, 'complete'); assert.equal(saved.pauses.length, 2);
  assert.equal(saved.pauses.at(-1).starts, null);
  assert.equal(await page.evaluate(() => inputTracks.every(t => t.readyState === 'ended')), true);
  assert.deepEqual(errors, []);
});

test('production 180s silence + 30s warning automatically drains and seals a recording', { timeout: 260000 }, async t => {
  assert.ok(process.env.OMN_VAD_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-silence-ui-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-vad-main.mjs', import.meta.url))], env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !document.getElementById('silence-enabled').disabled);
  await page.evaluate(() => {
    const context = new AudioContext({ sampleRate: 48000 });
    globalThis.testInputTracks = [];
    function source() {
      const osc = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
      gain.gain.value = 0; osc.connect(gain).connect(destination); osc.start();
      globalThis.testInputTracks.push(...destination.stream.getTracks()); return destination.stream;
    }
    navigator.mediaDevices.getDisplayMedia = async () => { await context.resume(); return source(); };
    navigator.mediaDevices.getUserMedia = async () => source();
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  const began = Date.now();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('silence-status').textContent.startsWith('무음 감시 중'), { timeout: 15000 });
  // If monitoring fails, fail promptly instead of waiting out the whole duration.
  const warning = await page.waitForFunction(() => {
    const text = document.getElementById('silence-status').textContent;
    if (text.includes('오류')) throw new Error(text);
    return !document.getElementById('silence-extend').hidden;
  }, undefined, { timeout: 200000 });
  await warning.dispose();
  const warned = Date.now(); assert.ok(warned - began >= 180000);
  const screenshots = fileURLToPath(new URL('../../../../work/app-qa/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.screenshot({ path: join(screenshots, 'silence-warning.png'), fullPage: true });
  await page.getByText('녹음 저장 완료', { exact: true }).waitFor({ timeout: 45000 });
  assert.ok(Date.now() - warned >= 29000);
  const ids = await readdir(join(directory, 'recordings')); assert.equal(ids.length, 1);
  const saved = await inspectRecording(join(directory, 'recordings', ids[0]));
  assert.equal(saved.state, 'complete');
  assert.ok(saved.cutoffs?.microphone > 0 || saved.index.length > 0);
  assert.equal(await page.evaluate(() => globalThis.testInputTracks.every(track => track.readyState === 'ended')), true);
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
  assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify({ elapsedMs: Date.now() - began, warningAfterMs: warned - began }));
});

test('VAD failure disables automatic stop while capture continues and can be saved manually', { timeout: 30000 }, async t => {
  assert.ok(process.env.OMN_VAD_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-silence-failure-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-vad-main.mjs', import.meta.url))], env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !document.getElementById('silence-enabled').disabled);
  await page.evaluate(() => {
    const context = new AudioContext(); globalThis.inputTracks = [];
    const source = () => { const out = context.createMediaStreamDestination(); const osc = context.createOscillator(); osc.connect(out); osc.start(); globalThis.inputTracks.push(...out.stream.getTracks()); return out.stream; };
    navigator.mediaDevices.getDisplayMedia = async () => { await context.resume(); return source(); };
    navigator.mediaDevices.getUserMedia = async () => source();
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.operation === 'vad') throw new Error('injected VAD transport failure');
      return post.call(this, message, ...args);
    };
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('무음 감시 오류로 자동 종료를 해제했습니다. 녹음은 계속됩니다. 직접 종료해 주세요.').waitFor();
  assert.equal(await page.locator('body').getAttribute('data-state'), 'recording');
  assert.equal(await page.evaluate(() => globalThis.inputTracks.every(track => track.readyState === 'live')), true);
  await page.getByRole('button', { name: '녹음 종료', exact: true }).click();
  await page.getByText('녹음 저장 완료', { exact: true }).waitFor();
  const ids = await readdir(join(directory, 'recordings'));
  assert.equal((await inspectRecording(join(directory, 'recordings', ids[0]))).state, 'complete');
});
