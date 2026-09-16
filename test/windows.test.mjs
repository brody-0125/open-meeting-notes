import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChunkStore } from '../src/store.mjs';
import { pcmWindows } from '../src/audio/windows.mjs';

async function fixture(t, count = 3) {
  const root = await mkdtemp(join(tmpdir(), 'omn-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root);
  for (const [source, sign] of [['microphone', 1], ['remote', -1]]) for (let seq = 0; seq < count; seq++) {
    const pcm = Buffer.alloc(6);
    for (let i = 0; i < 3; i++) pcm.writeInt16LE(sign * (seq * 3 + i + 1), i * 2);
    await store.put({ version: 1, sessionId: 'meeting', epoch: 0, source, seq, startFrame: seq * 3, frames: 3, sampleRate: 16000, channels: 1 }, pcm);
  }
  return { store, index: await store.index() };
}
const opts = { sessionId: 'meeting', source: 'microphone', windowFrames: 4, overlapFrames: 1 };

test('pause boundaries split STT windows without carrying overlap or inventing silent samples', async t => {
  for (const frames of [3, 4]) {
    const { store } = await fixture(t, 0);
    for (const seq of [0, 1]) {
      const pcm = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) pcm.writeInt16LE(seq * 10 + i + 1, i * 2);
      await store.put({ version: 1, sessionId: 'meeting', epoch: 0, source: 'microphone', seq,
        startFrame: seq ? frames + 8 : 0, frames, sampleRate: 16000, channels: 1 }, pcm);
    }
    const pauses = [{ pauseId: 1, cutoffs: { microphone: frames, remote: 0 }, starts: { microphone: frames + 8, remote: 8 } }];
    const windows = await Array.fromAsync(pcmWindows(store, await store.index(), { ...opts, pauses }));
    assert.deepEqual(windows.map(w => w.startFrame), [0, frames + 8]);
    assert.deepEqual(windows.map(w => [...w.samples].map(v => v * 32768)),
      [Array.from({ length: frames }, (_, i) => i + 1), Array.from({ length: frames }, (_, i) => i + 11)]);
  }
});

test('pause boundary inside stored PCM or an unrecorded gap remains invalid', async t => {
  const { store, index } = await fixture(t, 2);
  for (const [start, end] of [[1, 3], [3, 5]]) {
    const pauses = [{ pauseId: 1, cutoffs: { microphone: start, remote: 0 }, starts: { microphone: end, remote: 0 } }];
    await assert.rejects(Array.fromAsync(pcmWindows(store, index, { ...opts, pauses })), /pause|gap/);
  }
});
test('recovery index retains metadata and checksums without retaining PCM', async t => {
  const { index } = await fixture(t);
  assert.equal(index.chunks.length, 6);
  assert.ok(index.chunks.every(c => c.meta && c.checksum && !Object.hasOwn(c, 'pcm')));
});
test('C05 windows preserve source, offsets, overlap and final new samples', async t => {
  const { store, index } = await fixture(t);
  const windows = await Array.fromAsync(pcmWindows(store, index, opts));
  assert.deepEqual(windows.map(w => w.startFrame), [0, 3, 6]);
  assert.deepEqual(windows.map(w => [...w.samples].map(v => v * 32768)), [[1,2,3,4],[4,5,6,7],[7,8,9]]);
  assert.ok(windows.every(w => w.source === 'microphone' && w.sampleRate === 16000));
});
test('exact final window does not create an overlap-only duplicate', async t => {
  const { store, index } = await fixture(t, 2);
  const windows = await Array.fromAsync(pcmWindows(store, index, { ...opts, windowFrames: 4, overlapFrames: 2 }));
  assert.deepEqual(windows.map(w => w.startFrame), [0, 2]);
});
test('C05 refuses gaps, altered index metadata and corrupted recordings', async t => {
  const { store, index } = await fixture(t);
  const missing = structuredClone(index);
  missing.chunks = missing.chunks.filter(c => c.meta.source !== 'microphone' || c.meta.seq !== 1);
  await assert.rejects(Array.fromAsync(pcmWindows(store, missing, opts)), /gap/);
  const changed = structuredClone(index);
  changed.chunks.find(c => c.meta.source === 'microphone').checksum = 'f'.repeat(64);
  await assert.rejects(Array.fromAsync(pcmWindows(store, changed, opts)), /changed/);
  await assert.rejects(Array.fromAsync(pcmWindows(store, { ...index, errors: [{ file: 'bad' }] }, opts)), /damaged/);
  await assert.rejects(Array.fromAsync(pcmWindows(store, { ...index, partials: ['incomplete.partial'] }, opts)), /incomplete/);
});
test('pull-based reader stops reading ahead until consumer requests next window', async t => {
  const { store, index } = await fixture(t, 10);
  let reads = 0;
  const wrapped = { read: file => { reads++; return store.read(file); } };
  const iterator = pcmWindows(wrapped, index, opts);
  await iterator.next();
  assert.equal(reads, 2);
  await iterator.return();
  assert.equal(reads, 2);
});
test('C11 file reader rejects paths before touching filesystem', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.read('../outside.chunk'), /filename/);
});
