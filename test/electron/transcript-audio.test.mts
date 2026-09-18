import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';
import { PauseStore } from '../../src/pauses.mjs';

for (const paused of [false, true]) test(`Main preview validates provenance and original audio ${paused ? 'after pause' : 'without pauses'}`, { timeout: 60000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-preview-ipc-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), id = '77777777-7777-4777-8777-777777777777';
  const store = new ChunkStore(join(directory, 'recordings', id)), pcm = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) pcm.writeInt16LE(i, 2 * i);
  await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 0,
    startFrame: 0, frames: 16000, sampleRate: 16000, channels: 1 }, pcm);
  if (paused) {
    const pauses = new PauseStore(store.root, id);
    await pauses.pause({ pauseId: 1, cutoffs: { microphone: 16000, remote: 0 } });
    await pauses.resume({ pauseId: 1, starts: { microphone: 32000, remote: 16000 } });
    await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 1,
      startFrame: 32000, frames: 16000, sampleRate: 16000, channels: 1 }, pcm);
  }
  await sealRecording({ store, sessionId: id, cutoffs: paused ? { microphone: 48000, remote: 16000 } : { microphone: 16000, remote: 0 } });
  // Exercise Main, storage, provenance and IPC; model quality has separate tests.
  await page.evaluate(() => window.meeting.onInferenceRequest(message => {
    const key = message.input.key, offset = message.input.window.startFrame / message.input.window.sampleRate;
    window.meeting.inferenceResult({ id: message.id, runId: message.runId, result: [{
      id: `${key}:0`, jobId: key, source: 'microphone', start: offset + .25, end: offset + .75,
      rawText: 'candidate', flags: ['speech-unconfirmed']
    }] });
  }));
  const run = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const result = await page.evaluate(async ({ id, run }) => window.meeting.analyze(id, run, 'ko'), { id, run });
  const segmentId = result.transcript.segments[paused ? 1 : 0].id;
  for (const [runId, candidate] of [['stale', segmentId], [run, '../escape'], [run, 'unknown']])
    await assert.rejects(page.evaluate(([r, s]) => window.meeting.transcriptAudio(r, s), [runId, candidate]));
  const audio = await page.evaluate(([r, s]) => window.meeting.transcriptAudio(r, s), [run, segmentId]);
  assert.equal(audio.startFrame, paused ? 36000 : 4000); assert.equal(audio.sampleRate, 16000);
  assert.equal(audio.samples.length, 8000);
  for (let i = 0; i < audio.samples.length; i++) assert.equal(audio.samples[i], Math.fround((4000 + i) / 32768));
  await app.evaluate(() => {
    const ChunkStore = testChunkStore, original = ChunkStore.prototype.read;
    globalThis.previewReadStarted = new Promise(resolve => { globalThis.signalPreviewRead = resolve; });
    ChunkStore.prototype.read = async function (...args) {
      ChunkStore.prototype.read = original;
      await new Promise(resolve => { globalThis.releasePreviewRead = resolve; signalPreviewRead(); });
      return original.apply(this, args);
    };
  });
  await page.evaluate(([r, s]) => {
    globalThis.previewOutcome = null;
    window.meeting.transcriptAudio(r, s).then(value => { previewOutcome = { value }; }, error => { previewOutcome = { error: error.message }; });
  }, [run, segmentId]);
  await app.evaluate(() => previewReadStarted);
  await assert.rejects(page.evaluate(([r, s]) => window.meeting.transcriptAudio(r, s), [run, segmentId]), /unavailable/);
  await page.evaluate(([r, s]) => window.meeting.correctTranscript(r, s, 'edited'), [run, segmentId]);
  await app.evaluate(() => releasePreviewRead());
  await page.waitForFunction(() => previewOutcome !== null);
  assert.match(await page.evaluate(() => previewOutcome.error), /stale/);
  await assert.rejects(page.evaluate(([r, s]) => window.meeting.transcriptAudio(r, s), [run, segmentId]), /stale/);
  await page.evaluate(async ({ id, run }) => window.meeting.analyze(id, run, 'ko'), { id, run });
  assert.equal((await page.evaluate(([r, s]) => window.meeting.transcriptAudio(r, s), [run, segmentId])).samples.length, 8000);
  assert.deepEqual((await store.recover()).chunks[0].pcm, pcm);
});
