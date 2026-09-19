import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';
import { verifyDevelopmentPackage } from '../../src/package-integrity.mjs';

test('packaged app runs installed local VAD, STT and summary through its shipped UI and exports notes', { timeout: 180000 }, async t => {
  for (const key of ['OMN_WINDOWS_PACKAGE', 'OMN_STT_FIXTURE', 'OMN_SUMMARY_FIXTURE', 'OMN_VAD_FIXTURE']) assert.ok(process.env[key], key);
  await verifyDevelopmentPackage({ root: resolve(process.env.OMN_WINDOWS_PACKAGE), approvedManifestHash: process.env.OMN_PACKAGE_MANIFEST_HASH });
  const root = await mkdtemp(join(tmpdir(), 'omn-package-models-')), install = join(root, 'app'), profile = join(root, 'profile');
  let app;
  t.after(async () => { if (app) await app.close(); await rm(root, { recursive: true, force: true }); });
  await cp(resolve(process.env.OMN_WINDOWS_PACKAGE), install, { recursive: true });
  const config = { version: 1 };
  for (const [kind, variable] of [['stt', 'OMN_STT_FIXTURE'], ['summary', 'OMN_SUMMARY_FIXTURE'], ['vad', 'OMN_VAD_FIXTURE']]) {
    const modelRoot = resolve(process.env[variable]);
    const approval = JSON.parse(await readFile(join(modelRoot, 'fixture-approval.json'), 'utf8'));
    config[kind] = { root: modelRoot, approvedManifestHash: approval.manifestHash, ...(kind === 'stt' ? { modelId: 'whisper-tiny' } : {}) };
  }
  const configPath = join(install, 'resources/app/models/installed.json');
  let installedConfig;
  try { installedConfig = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installedConfig !== undefined) {
    assert.deepEqual(installedConfig, config, 'shipped model configuration must match the explicitly approved test packs');
    await verifyDevelopmentPackage({ root: install, approvedManifestHash: process.env.OMN_PACKAGE_MANIFEST_HASH });
  } else {
    await mkdir(join(install, 'resources/app/models'));
    await writeFile(configPath, JSON.stringify(config));
  }
  app = await electron.launch({ executablePath: join(install, 'open-meeting-notes.exe'), args: [`--user-data-dir=${profile}`] });
  assert.equal(await app.evaluate(({ app, BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(w => { w.hide(); w.webContents.setAudioMuted(true); }); return app.isPackaged; }), true);
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  assert.equal(await page.evaluate(() => typeof window.meeting.transcriptAudio === 'function' && typeof window.meeting.reviewTranscript === 'function'), true,
    'packaged app must expose the tested playback and speech-review flow');
  const wav = await readFile(join(config.stt.root, 'speech.wav'));
  const audio = await page.evaluate(async bytes => {
    const models = await window.meeting.models();
    if (models.error || !models.stt || !models.summary || !models.vad) throw new Error(JSON.stringify(models));
    const context = new AudioContext({ sampleRate: 16000 });
    const buffer = await context.decodeAudioData(new Uint8Array(bytes).buffer);
    const samples = buffer.getChannelData(0).slice(); await context.close();
    const { InferenceClient } = await import('/inference-client.mjs');
    const client = new InferenceClient(); let speech = 0, frames = 0;
    try {
      await client.run('vad-load', { modelHash: models.vad.modelHash });
      for (let i = 0; i + 512 <= samples.length; i += 512) {
        const result = await client.run('vad', { modelHash: models.vad.modelHash, source: 'microphone', samples: samples.slice(i, i + 512) });
        frames++; if (result.speech) speech++;
      }
    } finally { client.dispose(); }
    return { samples: [...samples], speech, frames };
  }, [...wav]);
  assert.ok(audio.speech > audio.frames * .3);
  const id = '33333333-3333-4333-8333-333333333333';
  const store = new ChunkStore(join(profile, 'recordings', id));
  for (let startFrame = 0, seq = 0; startFrame < audio.samples.length; startFrame += 80000, seq++) {
    const frames = Math.min(80000, audio.samples.length - startFrame), pcm = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) { const value = Math.max(-1, Math.min(1, audio.samples[startFrame + i])); pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2); }
    await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq, startFrame, frames, sampleRate: 16000, channels: 1 }, pcm);
  }
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: audio.samples.length, remote: 0 } });
  await page.getByRole('button', { name: '목록 새로고침', exact: true }).click();
  await page.locator('#analysis-language').selectOption('en');
  await page.getByRole('button', { name: '전사·요약', exact: true }).click();
  await page.getByText('전사·요약 완료 · 요약 후보를 원문과 비교해 검토하세요.').waitFor({ timeout: 120000 });
  assert.match(await page.locator('#transcript').innerText(), /report/i);
  assert.ok(await page.locator('#summary blockquote').count() > 0);
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
  await page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }).waitFor();
  const exported = (await page.locator('#export-status').innerText()).replace('이 기기에 저장했습니다: ', '');
  assert.match(await readFile(exported, 'utf8'), /검토 전 후보/);
  await page.getByRole('button', { name: '원음 재생', exact: true }).first().click();
  await page.getByRole('button', { name: '재생 중지', exact: true }).waitFor();
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await page.getByRole('button', { name: '원음 재생', exact: true }).first().waitFor();

  const noiseId = '44444444-4444-4444-8444-444444444444', noise = new ChunkStore(join(profile, 'recordings', noiseId));
  let seed = 123456789;
  for (let seq = 0; seq < 2; seq++) {
    const pcm = Buffer.alloc(160000);
    for (let i = 0; i < 80000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pcm.writeInt16LE(Math.round(.0003 * (2 * seed / 4294967296 - 1) * 32767), i * 2);
    }
    await noise.put({ version: 1, sessionId: noiseId, epoch: 0, source: 'microphone', seq,
      startFrame: seq * 80000, sampleRate: 16000, channels: 1, frames: 80000 }, pcm);
  }
  await sealRecording({ store: noise, sessionId: noiseId, cutoffs: { microphone: 160000, remote: 0 } });
  const noiseBefore = await noise.index();
  await page.getByRole('button', { name: '목록 새로고침', exact: true }).click();
  await page.locator('#analysis-language').selectOption('ko');
  await page.locator('.record-picker').filter({ hasText: noiseId }).click();
  await page.getByRole('button', { name: '전사·요약', exact: true }).click();
  await page.locator('#analysis-export').waitFor({ state: 'visible', timeout: 60000 });
  assert.match(await page.locator('#analysis-status').innerText(), /요약을 보류/);
  assert.equal(await page.locator('#summary blockquote').count(), 0);
  const count = await page.locator('.speech-review-choice').count(); assert.ok(count > 0 && count <= 4);
  for (let i = 0; i < count; i++) {
    await page.locator('.speech-review-choice').nth(i).selectOption('rejected');
    await page.waitForFunction(i => {
      const select = document.querySelectorAll('.speech-review-choice')[i];
      return select?.value === 'rejected' && !select.disabled && !document.querySelector('#analysis-export').hidden;
    }, i);
  }
  assert.match(await page.locator('#analysis-status').innerText(), /사용자 판단으로 모든 전사를 요약에서 제외/);
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
  await page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }).waitFor();
  const noiseExport = (await page.locator('#export-status').innerText()).replace('이 기기에 저장했습니다: ', '');
  assert.match(await readFile(noiseExport, 'utf8'), /사용자가 요약 근거에서 제외/);
  assert.deepEqual(await noise.index(), noiseBefore);
  assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify({ packaged: true, vadSpeechFrames: audio.speech, vadFrames: audio.frames, exported: true,
    playback: true, noiseSummaryBlocked: true, excludedCandidates: count }));
});
