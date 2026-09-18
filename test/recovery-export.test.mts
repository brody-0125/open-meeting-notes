import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChunkStore } from '../src/store.mjs';
import { inspectRecording, sealRecording } from '../src/recording-seal.mjs';
import { PauseStore } from '../src/pauses.mjs';
import { exportRecoveredAudio } from '../src/recovery-export.mjs';

const id = '44444444-4444-4444-8444-444444444444';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omn-recovery-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(join(root, id));
  const put = (seq, startFrame, source = 'microphone') => store.put({ version: 1, sessionId: id, epoch: 0,
    source, seq, startFrame, frames: 160, sampleRate: 16000, channels: 1 }, Buffer.alloc(320, seq + 1));
  return { root, store, put, run: () => exportRecoveredAudio({ root: store.root, directory: join(root, 'exports'), sessionId: id }) };
}

test('recovery preserves recorded pauses without claiming incomplete audio was fully verified', async t => {
  for (const sealed of [false, true]) {
    const { store, put, run } = await fixture(t), pauses = new PauseStore(store.root, id);
    await put(0, 0); await pauses.pause({ pauseId: 1, cutoffs: { microphone: 160, remote: 0 } });
    await pauses.resume({ pauseId: 1, starts: { microphone: 480, remote: 320 } }); await put(1, 480);
    if (sealed) await sealRecording({ store, sessionId: id, cutoffs: { microphone: 640, remote: 320 } });
    const result = await run(), manifest = JSON.parse(await readFile(join(result.path, 'recovery.json'), 'utf8'));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.pauseMetadata.verification, sealed ? 'recording-verified' : 'metadata-only');
    assert.deepEqual(manifest.pauseMetadata.records, await pauses.read());
    assert.deepEqual(manifest.spans.map(s => [s.startFrame, s.frames]), [[0, 160], [480, 160]]);
    for (const span of manifest.spans) assert.equal((await readFile(join(result.path, span.file))).length, 364);
  }
});

test('unreadable pause metadata is reported without discarding recoverable PCM', async t => {
  const { store, put, run } = await fixture(t); await put(0, 0);
  await writeFile(join(store.root, 'pauses.json'), 'broken');
  const result = await run(), manifest = JSON.parse(await readFile(join(result.path, 'recovery.json'), 'utf8'));
  assert.equal(manifest.pauseMetadata.verification, 'unreadable');
  assert.equal(manifest.spans.length, 1);
  assert.equal(await readFile(join(store.root, 'pauses.json'), 'utf8'), 'broken');
});

test('pause metadata changing during export prevents publication of a mixed snapshot', async t => {
  const { root, store, put, run } = await fixture(t); await put(0, 0);
  const pauses = new PauseStore(store.root, id);
  await pauses.pause({ pauseId: 1, cutoffs: { microphone: 160, remote: 0 } });
  const original = ChunkStore.prototype.read; let reads = 0;
  t.mock.method(ChunkStore.prototype, 'read', async function (...args) {
    const result = await original.apply(this, args);
    // The first two reads inspect/index; the third copies PCM to the export.
    if (this.root === store.root && ++reads === 3) {
      await pauses.resume({ pauseId: 1, starts: { microphone: 480, remote: 320 } });
    }
    return result;
  });
  await assert.rejects(run(), /pause metadata changed/);
  assert.deepEqual(await readdir(join(root, 'exports')), []);
});

test('recovery exports contiguous WAV spans without filling gaps or changing the incomplete source', async t => {
  const { store, put, run } = await fixture(t);
  await put(0, 0); await put(1, 160); await put(3, 480); await put(0, 0, 'remote');
  await writeFile(join(store.root, 'unfinished.partial'), 'not committed');
  const snapshot = async () => Promise.all((await readdir(store.root)).sort().map(async file => [file, await readFile(join(store.root, file))]));
  const before = await snapshot(), result = await run();
  const manifest = JSON.parse(await readFile(join(result.path, 'recovery.json'), 'utf8'));
  assert.equal(manifest.state, 'recovered-excerpts');
  assert.equal(manifest.originalState, 'incomplete');
  assert.deepEqual(manifest.partials, ['unfinished.partial']);
  assert.deepEqual(manifest.spans.map(s => [s.source, s.startFrame, s.frames]), [
    ['microphone', 0, 320], ['microphone', 480, 160], ['remote', 0, 160]
  ]);
  const wav = await readFile(join(result.path, manifest.spans[0].file));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(40), 640); assert.equal(wav.length, 684);
  assert.deepEqual(wav.subarray(44), Buffer.concat([Buffer.alloc(320, 1), Buffer.alloc(320, 2)]));
  assert.deepEqual(await snapshot(), before);
  assert.equal((await inspectRecording(store.root)).state, 'incomplete');
  assert.notEqual((await run()).path, result.path);
});

test('corrupt chunks are reported and never included in recovered audio', async t => {
  const { store, put, run } = await fixture(t);
  const bad = await put(0, 0); await put(1, 160);
  const path = join(store.root, bad.file), bytes = await readFile(path); bytes[bytes.length - 1] ^= 1;
  await writeFile(path, bytes);
  const result = await run(), manifest = JSON.parse(await readFile(join(result.path, 'recovery.json'), 'utf8'));
  assert.equal(manifest.originalState, 'damaged');
  assert.equal(manifest.errors[0].file, bad.file);
  assert.deepEqual(manifest.spans.map(s => [s.startFrame, s.frames]), [[160, 160]]);
  assert.deepEqual(await readFile(path), bytes);
});

test('overlapping committed chunks cannot be exported as an unambiguous recovery', async t => {
  const { root, put, run } = await fixture(t);
  await put(0, 0); await put(1, 80);
  await assert.rejects(run(), /overlap/);
  assert.deepEqual(await readdir(join(root, 'exports')).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []);
});

test('foreign session chunks and empty recordings are rejected before publishing', async t => {
  const { root, store, put, run } = await fixture(t);
  await put(0, 0);
  await store.put({ version: 1, sessionId: 'foreign', epoch: 0, source: 'remote', seq: 0,
    startFrame: 0, frames: 160, sampleRate: 16000, channels: 1 }, Buffer.alloc(320));
  await assert.rejects(run(), /foreign/);
  await rm(join(store.root, 'foreign.0.remote.0.chunk'));
  await rm(join(store.root, `${id}.0.microphone.0.chunk`));
  await assert.rejects(run(), /no verified audio/);
  assert.deepEqual(await readdir(join(root, 'exports')).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []);
});

test('damage after indexing aborts publication and removes staged output without repairing the source', async t => {
  const { root, store, put, run } = await fixture(t);
  const first = await put(0, 0), second = await put(1, 160);
  const originalFirst = await readFile(join(store.root, first.file));
  const path = join(store.root, second.file), damaged = await readFile(path);
  damaged[damaged.length - 1] ^= 1;
  const original = ChunkStore.prototype.index; let reads = 0;
  t.mock.method(ChunkStore.prototype, 'index', async function () {
    const result = await original.call(this);
    if (this.root === store.root && ++reads === 2) await writeFile(path, damaged);
    return result;
  });
  await assert.rejects(run(), /checksum/);
  assert.equal(reads, 2);
  assert.deepEqual(await readdir(join(root, 'exports')), []);
  assert.deepEqual(await readFile(path), damaged);
  assert.deepEqual(await readFile(join(store.root, first.file)), originalFirst);
});
