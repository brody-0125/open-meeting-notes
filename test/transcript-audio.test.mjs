import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChunkStore } from '../src/store.mjs';
import { transcriptAudio } from '../src/transcript-audio.mjs';

test('preview after pause uses original frames and refuses ranges spanning the interruption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-paused-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root);
  for (const [seq, startFrame] of [[0, 0], [1, 32000]]) await store.put({ version: 1, sessionId: 'preview', epoch: 0,
    source: 'microphone', seq, startFrame, frames: 16000, sampleRate: 16000, channels: 1 }, Buffer.alloc(32000, seq + 1));
  const index = await store.index(), options = { pauses: [{ pauseId: 1, cutoffs: { microphone: 16000, remote: 0 },
    starts: { microphone: 32000, remote: 16000 } }] };
  const result = await transcriptAudio(store, index, 'preview', { source: 'microphone', epoch: 0, start: 2, end: 2.5 }, options);
  assert.equal(result.startFrame, 32000); assert.equal(result.samples.length, 8000);
  assert.ok(result.samples.every(value => value === 514 / 32768));
  await assert.rejects(transcriptAudio(store, index, 'preview', { source: 'microphone', epoch: 0, start: .5, end: 2.5 }, options), /unavailable/);
  assert.deepEqual(await store.index(), index);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omn-transcript-audio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root);
  for (let seq = 0; seq < 7; seq++) {
    const pcm = Buffer.alloc(16000 * 5 * 2);
    for (let i = 0; i < 80000; i++) pcm.writeInt16LE((seq * 80000 + i) % 30000, i * 2);
    await store.put({ version: 1, sessionId: 'preview', epoch: 0, source: 'microphone', seq,
      startFrame: seq * 80000, sampleRate: 16000, channels: 1, frames: 80000 }, pcm);
  }
  return { store, index: await store.index() };
}

test('preview extracts exact native-rate source frames across stored chunks without modifying them', async t => {
  const { store, index } = await fixture(t);
  const result = await transcriptAudio(store, index, 'preview', { source: 'microphone', epoch: 0, start: 29, end: 31 });
  assert.equal(result.sampleRate, 16000); assert.equal(result.startFrame, 29 * 16000);
  assert.equal(result.samples.length, 32000);
  for (let i = 0; i < result.samples.length; i++) assert.equal(result.samples[i], Math.fround(((29 * 16000 + i) % 30000) / 32768));
  assert.deepEqual(await store.index(), index);
});

test('preview rejects wrong source, epoch, session, invalid bounds, empty range and cancellation', async t => {
  const { store, index } = await fixture(t);
  const segment = { source: 'microphone', epoch: 0, start: 1, end: 2 };
  for (const patch of [{ source: 'remote' }, { epoch: 1 }, { start: -1 }, { start: NaN },
    { end: Infinity }, { start: 2 }, { end: 32 }, { start: 40, end: 41 }]) {
    await assert.rejects(transcriptAudio(store, index, 'preview', { ...segment, ...patch }));
  }
  await assert.rejects(transcriptAudio(store, index, 'other', segment));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transcriptAudio(store, index, 'preview', segment, { signal: controller.signal }), { name: 'AbortError' });
});

test('preview refuses partial recordings, gaps and bytes changed after indexing', async t => {
  const { store, index } = await fixture(t);
  const segment = { source: 'microphone', epoch: 0, start: 29, end: 31 };
  await assert.rejects(transcriptAudio(store, { ...index, partials: ['pending'] }, 'preview', segment), /incomplete/);
  await assert.rejects(transcriptAudio(store, { ...index, chunks: index.chunks.filter(c => c.meta.seq !== 1) }, 'preview', segment), /gap/);
  const path = join(store.root, index.chunks[0].file);
  await writeFile(path, Buffer.from('damaged'));
  await assert.rejects(transcriptAudio(store, index, 'preview', segment), /header/);
});
