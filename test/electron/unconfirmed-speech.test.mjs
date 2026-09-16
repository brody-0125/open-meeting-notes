import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';

test('real app blocks first and cached noise summaries while preserving audio and allowing actual speech summaries', { timeout: 180000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE && process.env.OMN_VAD_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-unconfirmed-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), id = '55555555-5555-4555-8555-555555555555';
  assert.ok((await page.evaluate(() => window.meeting.models())).vad);
  const store = new ChunkStore(join(directory, 'recordings', id));
  const originals = [];
  for (const source of ['microphone', 'remote']) {
    const pcm = Buffer.alloc(320000); let seed = 123456789;
    for (let i = 0; i < 160000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value = source === 'microphone' ? .002 * Math.sin(2 * Math.PI * 60 * i / 16000) : .0003 * (2 * seed / 4294967296 - 1);
      pcm.writeInt16LE(Math.round(value * 32767), i * 2);
    }
    for (let seq = 0; seq < 2; seq++) await store.put({ version: 1, sessionId: id, epoch: 0, source, seq, startFrame: seq * 80000,
      frames: 80000, sampleRate: 16000, channels: 1 }, pcm.subarray(seq * 160000, (seq + 1) * 160000));
    originals.push(pcm);
  }
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 160000, remote: 160000 } });
  const before = await store.index();
  await page.evaluate(() => {
    globalThis.operations = [];
    window.meeting.onInferenceRequest(message => operations.push(message.operation));
  });
  await page.getByRole('button', { name: '목록 새로고침' }).click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '전사·요약', exact: true }).click();
    await page.locator('#analysis-export').waitFor({ state: 'visible', timeout: 60000 });
    assert.ok(await page.locator('#transcript li').count() > 0);
    assert.equal(await page.locator('#summary blockquote').count(), 0);
    assert.match(await page.locator('#transcript').innerText(), /발화 미확인/);
    assert.match(await page.locator('#analysis-status').innerText(), /요약을 보류/);
    assert.deepEqual(await page.evaluate(() => operations), ['transcribe', 'transcribe']);
  }
  await page.getByRole('button', { name: 'Markdown 저장' }).click();
  const status = page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }); await status.waitFor();
  const path = (await status.innerText()).replace('이 기기에 저장했습니다: ', '');
  assert.match(await readFile(path, 'utf8'), /상태: 발화 미확인/);
  assert.deepEqual(await store.index(), before);
  for (const chunk of before.chunks) {
    assert.deepEqual((await store.read(chunk.file)).pcm, originals[chunk.meta.source === 'microphone' ? 0 : 1]
      .subarray(chunk.meta.seq * 160000, (chunk.meta.seq + 1) * 160000));
  }
  const speechId = '66666666-6666-4666-8666-666666666666';
  const wav = await readFile(join(process.env.OMN_STT_FIXTURE, 'speech.wav'));
  const samples = await page.evaluate(async bytes => {
    const context = new AudioContext({ sampleRate: 16000 });
    try { return [...(await context.decodeAudioData(new Uint8Array(bytes).buffer)).getChannelData(0)]; }
    finally { await context.close(); }
  }, [...wav]);
  const speech = new ChunkStore(join(directory, 'recordings', speechId));
  for (let start = 0, seq = 0; start < samples.length; start += 80000, seq++) {
    const frames = Math.min(80000, samples.length - start), pcm = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[start + i])) * 32767), i * 2);
    await speech.put({ version: 1, sessionId: speechId, epoch: 0, source: 'microphone', seq,
      startFrame: start, frames, sampleRate: 16000, channels: 1 }, pcm);
  }
  await sealRecording({ store: speech, sessionId: speechId, cutoffs: { microphone: samples.length, remote: 0 } });
  await page.evaluate(async id => { const { analyze } = await import('/analysis.mjs'); await analyze(id, 'en'); }, speechId);
  assert.match(await page.locator('#transcript').innerText(), /report/i);
  assert.doesNotMatch(await page.locator('#transcript').innerText(), /발화 미확인/);
  assert.ok(await page.locator('#summary blockquote').count() > 0);
  assert.ok(await page.evaluate(() => operations.includes('summarize')));
});
