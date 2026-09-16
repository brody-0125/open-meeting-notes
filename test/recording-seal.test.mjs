import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChunkStore } from '../src/store.mjs';
import { PauseStore } from '../src/pauses.mjs';
import { sealRecording, inspectRecording } from '../src/recording-seal.mjs';

const meta = overrides => ({ version: 1, sessionId: 'meeting', epoch: 0, source: 'microphone', seq: 0,
  startFrame: 0, frames: 2, sampleRate: 48000, channels: 1, ...overrides });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omn-seal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root);
  await store.put(meta({}), Buffer.alloc(4));
  await store.put(meta({ source: 'remote' }), Buffer.alloc(4));
  return { root, store, sessionId: 'meeting', cutoffs: { microphone: 2, remote: 2 } };
}

test('sealing accepts only the exact gap recorded for each source and binds pause metadata', async t => {
  const f = await fixture(t), pauses = new PauseStore(f.root, f.sessionId);
  await pauses.pause({ pauseId: 1, cutoffs: f.cutoffs });
  await pauses.resume({ pauseId: 1, starts: { microphone: 10, remote: 12 } });
  await f.store.put(meta({ seq: 1, startFrame: 10 }), Buffer.alloc(4));
  await f.store.put(meta({ source: 'remote', seq: 1, startFrame: 12 }), Buffer.alloc(4));
  f.cutoffs = { microphone: 12, remote: 14 };
  const marker = await sealRecording(f);
  assert.equal(marker.version, 2);
  assert.match(marker.pausesHash, /^[a-f0-9]{64}$/);
  const result = await inspectRecording(f.root);
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.pauses, await pauses.read());
  await rm(join(f.root, 'pauses.json'));
  assert.equal((await inspectRecording(f.root)).state, 'damaged');
});

test('open final pause and zero-length resumed pause preserve valid completion', async t => {
  for (const resume of [false, true]) {
    const f = await fixture(t), pauses = new PauseStore(f.root, f.sessionId);
    await pauses.pause({ pauseId: 1, cutoffs: f.cutoffs });
    if (resume) await pauses.resume({ pauseId: 1, starts: f.cutoffs });
    await sealRecording(f);
    assert.equal((await inspectRecording(f.root)).state, 'complete');
  }
});

test('validly rewritten pause metadata invalidates a previously sealed marker', async t => {
  const f = await fixture(t), pauses = new PauseStore(f.root, f.sessionId);
  await pauses.pause({ pauseId: 1, cutoffs: f.cutoffs });
  await sealRecording(f);
  await pauses.resume({ pauseId: 1, starts: f.cutoffs });
  assert.equal((await inspectRecording(f.root)).state, 'damaged');
  await assert.rejects(sealRecording(f), /conflict/);
});

test('consecutive pauses and a final resumed interval without PCM retain all boundaries', async t => {
  const f = await fixture(t), pauses = new PauseStore(f.root, f.sessionId);
  await pauses.pause({ pauseId: 1, cutoffs: f.cutoffs });
  await pauses.resume({ pauseId: 1, starts: { microphone: 10, remote: 12 } });
  await pauses.pause({ pauseId: 2, cutoffs: { microphone: 10, remote: 12 } });
  await pauses.resume({ pauseId: 2, starts: { microphone: 20, remote: 24 } });
  await sealRecording({ ...f, cutoffs: { microphone: 20, remote: 24 } });
  const result = await inspectRecording(f.root);
  assert.equal(result.state, 'complete'); assert.equal(result.pauses.length, 2);
  assert.equal(result.index.chunks.length, 2);
});

test('pause records cannot excuse audio inside a pause or a different missing interval', async t => {
  for (const startFrame of [2, 9, 11]) {
    const f = await fixture(t), pauses = new PauseStore(f.root, f.sessionId);
    await pauses.pause({ pauseId: 1, cutoffs: f.cutoffs });
    await pauses.resume({ pauseId: 1, starts: { microphone: 10, remote: 10 } });
    await f.store.put(meta({ seq: 1, startFrame }), Buffer.alloc(4));
    await assert.rejects(sealRecording({ ...f, cutoffs: { microphone: startFrame + 2, remote: 10 } }), /gap|pause/);
  }
});

test('unmatched pause boundary and audio after an open pause cannot be sealed', async t => {
  for (const cutoff of [1, 2, 3]) {
    const f = await fixture(t), pauses = new PauseStore(f.root, f.sessionId);
    await pauses.pause({ pauseId: 1, cutoffs: { microphone: cutoff, remote: 2 } });
    await f.store.put(meta({ seq: 1, startFrame: 2 }), Buffer.alloc(4));
    await assert.rejects(sealRecording({ ...f, cutoffs: { microphone: 4, remote: 2 } }), /pause/);
  }
});
test('audio without completion marker is incomplete; sealed audio verifies after fresh store', async t => {
  const f = await fixture(t);
  assert.equal((await inspectRecording(f.root)).state, 'incomplete');
  await sealRecording(f);
  const result = await inspectRecording(f.root);
  assert.equal(result.state, 'complete');
  assert.equal(result.sessionId, 'meeting');
  assert.deepEqual(result.cutoffs, f.cutoffs);
  assert.equal(result.index.chunks.length, 2);
  await sealRecording(f); // Retry of the same completion is idempotent.
});
test('cutoff mismatch and audio gaps cannot be sealed', async t => {
  const f = await fixture(t);
  await assert.rejects(sealRecording({ ...f, cutoffs: { microphone: 3, remote: 2 } }), /cutoff/);
  await f.store.put(meta({ seq: 2, startFrame: 4 }), Buffer.alloc(4));
  await assert.rejects(sealRecording(f), /gap/);
  assert.equal((await inspectRecording(f.root)).state, 'incomplete');
});

test('unsealed audio still checks committed checksums while unfinished writes remain incomplete', async t => {
  const f = await fixture(t);
  const partial = join(f.root, 'unfinished.partial');
  await writeFile(partial, 'not a committed audio chunk');
  assert.equal((await inspectRecording(f.root)).state, 'incomplete');
  const path = join(f.root, 'meeting.0.microphone.0.chunk');
  const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1;
  await writeFile(path, bytes);
  assert.equal((await inspectRecording(f.root)).state, 'damaged');
  assert.deepEqual(await readFile(path), bytes, 'inspection must not repair or overwrite damaged evidence');
  assert.equal(await readFile(partial, 'utf8'), 'not a committed audio chunk');
});
test('missing, extra and corrupted audio invalidate previously completed session', async t => {
  for (const mode of ['missing', 'extra', 'corrupt']) {
    const f = await fixture(t);
    await sealRecording(f);
    const file = join(f.root, 'meeting.0.microphone.0.chunk');
    if (mode === 'missing') await rm(file);
    if (mode === 'extra') await f.store.put(meta({ seq: 1, startFrame: 2 }), Buffer.alloc(4));
    if (mode === 'corrupt') await writeFile(file, 'bad');
    assert.equal((await inspectRecording(f.root)).state, 'damaged');
  }
});
test('modified completion marker is rejected rather than silently overwritten', async t => {
  const f = await fixture(t);
  await sealRecording(f);
  const path = join(f.root, 'complete.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  value.cutoffs.microphone = 9;
  await writeFile(path, JSON.stringify(value));
  assert.equal((await inspectRecording(f.root)).state, 'damaged');
  await assert.rejects(sealRecording(f), /conflict/);
});
test('failure before completion rename leaves audio incomplete and retryable', async t => {
  const f = await fixture(t);
  await assert.rejects(sealRecording({ ...f, checkpoint: async stage => {
    if (stage === 'synced') throw new Error('injected interruption');
  } }), /interruption/);
  assert.equal((await inspectRecording(f.root)).state, 'incomplete');
  await sealRecording(f);
  assert.equal((await inspectRecording(f.root)).state, 'complete');
});
