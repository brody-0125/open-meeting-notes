import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';
import { PauseStore } from '../../src/pauses.mjs';
import { verifyDevelopmentPackage } from '../../src/package-integrity.mjs';

test('local Korean small model preserves negation through app transcription, summary, cache and export', { timeout: 180000 }, async t => {
  const withPause = process.env.OMN_SMALL_FLOW_PAUSE === '1';
  for (const key of ['OMN_STT_FIXTURE', 'OMN_SUMMARY_FIXTURE', 'OMN_VAD_FIXTURE', 'OMN_KOREAN_SPEECH']) assert.ok(process.env[key], key);
  const packageRoot = process.env.OMN_WINDOWS_PACKAGE && resolve(process.env.OMN_WINDOWS_PACKAGE);
  if (packageRoot) await verifyDevelopmentPackage({ root: packageRoot, approvedManifestHash: process.env.OMN_PACKAGE_MANIFEST_HASH });
  const directory = await mkdtemp(join(tmpdir(), 'omn-small-flow-'));
  const app = await electron.launch({ ...(packageRoot ? { executablePath: join(packageRoot, 'open-meeting-notes.exe'),
    args: [`--user-data-dir=${directory}`] } : { args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))] }),
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  const packaged = await app.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach(w => w.hide()); return app.isPackaged;
  });
  assert.equal(packaged, Boolean(packageRoot));
  page.on('pageerror', error => errors.push(error.message));
  const models = await page.evaluate(() => window.meeting.models());
  assert.equal(models.stt.modelId, 'whisper-small'); assert.equal(models.error, null);
  for (const [kind, variable] of [['stt', 'OMN_STT_FIXTURE'], ['summary', 'OMN_SUMMARY_FIXTURE'], ['vad', 'OMN_VAD_FIXTURE']]) {
    const approval = JSON.parse(await readFile(join(process.env[variable], 'fixture-approval.json'), 'utf8'));
    assert.equal(models[kind].modelHash, approval.manifestHash);
  }
  const wav = await readFile(join(process.env.OMN_KOREAN_SPEECH, 'negation.wav'));
  const samples = await page.evaluate(async bytes => {
    const context = new AudioContext({ sampleRate: 16000 });
    const decoded = await context.decodeAudioData(new Uint8Array(bytes).buffer);
    const samples = decoded.getChannelData(0).slice(); await context.close();
    let seed = 123456789;
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = samples[i] * .02 + .0003 * (2 * seed / 4294967296 - 1);
    }
    globalThis.operations = []; globalThis.transcriptionWindows = [];
    window.meeting.onInferenceRequest(message => {
      operations.push(message.operation);
      if (message.operation === 'transcribe') transcriptionWindows.push({ startFrame: message.input.window.startFrame, frames: message.input.window.samples.length });
    });
    return [...samples];
  }, [...wav]);
  const id = '77777777-7777-4777-8777-777777777777', store = new ChunkStore(join(directory, 'recordings', id));
  let seq = 0;
  const resumedAt = samples.length + 15 * 16000;
  for (const offset of withPause ? [0, resumedAt] : [0]) {
    for (let frame = 0; frame < samples.length; frame += 80000, seq++) {
      const frames = Math.min(80000, samples.length - frame), pcm = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(samples[frame + i] * 32767), i * 2);
      await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq, startFrame: offset + frame, frames, sampleRate: 16000, channels: 1 }, pcm);
    }
  }
  if (withPause) {
    const pauses = new PauseStore(store.root, id);
    await pauses.pause({ pauseId: 1, cutoffs: { microphone: samples.length, remote: 0 } });
    await pauses.resume({ pauseId: 1, starts: { microphone: resumedAt, remote: 15 * 16000 } });
  }
  await sealRecording({ store, sessionId: id, cutoffs: {
    microphone: withPause ? resumedAt + samples.length : samples.length, remote: withPause ? 15 * 16000 : 0
  } });
  const original = await store.index();
  await page.getByRole('button', { name: '목록 새로고침', exact: true }).click();
  await page.locator('#analysis-language').selectOption('ko');
  const analyze = async () => {
    await page.getByRole('button', { name: '전사·요약', exact: true }).click();
    await page.locator('#analysis-export').waitFor({ state: 'visible', timeout: 120000 });
  };
  await analyze();
  const transcript = await page.locator('#transcript').innerText(), summary = await page.locator('#summary').innerText();
  assert.match(transcript, /승인하지 않았습니다/); assert.match(transcript, /보류합니다/);
  assert.ok(await page.locator('#summary blockquote').count() > 0);
  const operations = await page.evaluate(() => globalThis.operations);
  const windows = await page.evaluate(() => globalThis.transcriptionWindows);
  if (withPause) {
    assert.deepEqual(windows, [{ startFrame: 0, frames: samples.length }, { startFrame: resumedAt, frames: samples.length }]);
    assert.match(await page.locator('#analysis-pauses').innerText(), /사용자 일시정지/);
    assert.ok((await page.locator('#transcript small').allTextContents()).some(label => label.includes(`${(resumedAt / 16000).toFixed(1)}초`)));
  }
  assert.ok(operations.includes('transcribe')); assert.ok(operations.includes('summarize'));
  await analyze();
  assert.deepEqual(await page.evaluate(() => globalThis.operations), operations);
  assert.equal(await page.locator('#transcript').innerText(), transcript);
  assert.equal(await page.locator('#summary').innerText(), summary);
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
  const status = page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }); await status.waitFor();
  const markdown = await readFile((await status.innerText()).replace('이 기기에 저장했습니다: ', ''), 'utf8');
  assert.match(markdown, /승인하지 않았습니다/); assert.match(markdown, /보류합니다/);
  if (withPause) assert.match(markdown, /사용자 일시정지/);
  assert.deepEqual(await store.index(), original); assert.deepEqual(errors, []);
  if (packageRoot) await verifyDevelopmentPackage({ root: packageRoot, approvedManifestHash: process.env.OMN_PACKAGE_MANIFEST_HASH });
  const report = { packaged, packageManifestHash: packageRoot ? process.env.OMN_PACKAGE_MANIFEST_HASH : null,
    model: models.stt, source: 'Heami negation, gain .02 and deterministic noise ±.0003, PCM16', transcript, summary,
    withPause, pauseSeconds: withPause ? 15 : 0, transcriptionWindows: windows,
    operations, cached: true, audioIndexUnchanged: true, exported: true };
  if (process.env.OMN_SMALL_FLOW_REPORT) await writeFile(process.env.OMN_SMALL_FLOW_REPORT, JSON.stringify(report, null, 2), { flag: 'wx' });
  t.diagnostic(JSON.stringify(report));
});
