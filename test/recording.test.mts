import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recording } from '../src/recording.mjs';
import { ChunkStore } from '../src/store.mjs';
import { PauseStore } from '../src/pauses.mjs';
import { sealRecording, inspectRecording } from '../src/recording-seal.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const pcm = Buffer.from([0, 0, 1, 0]);

test('pause boundaries bind to committed audio and only durable resume admits the next span', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-recording-pause-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root), r = new Recording('meeting', store);
  r.start(r.requestConsent()); await r.append(meta(), pcm);
  await assert.rejects(r.pause({ pauseId: 1, cutoffs: { microphone: 3, remote: 0 } }), /boundary/);
  assert.equal(r.state, 'recording');
  await r.pause({ pauseId: 1, cutoffs: { microphone: 2, remote: 0 } });
  assert.equal(r.state, 'paused');
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 2 }), pcm), /paused/);
  await assert.rejects(r.resume({ pauseId: 2, starts: { microphone: 10, remote: 8 } }), /resume/);
  await r.resume({ pauseId: 1, starts: { microphone: 10, remote: 8 } });
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 2 }), pcm), /frame/);
  await r.append(meta({ seq: 1, startFrame: 10 }), pcm);
  r.stop({ microphone: 12, remote: 8 }); await r.finish();
  assert.equal(r.state, 'stopped');
  assert.deepEqual(await new PauseStore(root, 'meeting').read(), [{ pauseId: 1,
    cutoffs: { microphone: 2, remote: 0 }, starts: { microphone: 10, remote: 8 } }]);
  const index = await store.index();
  assert.deepEqual(index.chunks.map(c => c.meta.startFrame), [0, 10]);
  await sealRecording({ store, sessionId: 'meeting', cutoffs: { microphone: 12, remote: 8 } });
  assert.equal((await inspectRecording(root)).state, 'complete');
});

test('pending audio precedes pause persistence and abort wins over a late metadata ACK', async () => {
  let audioAck, pauseAck, called = false;
  const r = new Recording('meeting', { put: () => new Promise(resolve => { audioAck = resolve; }) },
    { pauseStore: { pause: () => { called = true; return new Promise(resolve => { pauseAck = resolve; }); } } });
  r.start(r.requestConsent()); const write = r.append(meta(), pcm);
  const pending = r.pause({ pauseId: 1, cutoffs: { microphone: 2, remote: 0 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.state, 'pausing'); assert.equal(called, false);
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 2 }), pcm), /paused/);
  audioAck({ durable: true }); await write; await new Promise(resolve => setImmediate(resolve));
  r.abort('device lost'); pauseAck({ durable: true });
  await assert.rejects(pending, /device lost/); assert.equal(r.state, 'failed');
});

test('resuming rejects PCM until metadata ACK and preserves failure on non-durable ACK', async () => {
  let ack;
  const r = new Recording('meeting', { put: async () => ({ durable: true }) }, { pauseStore: {
    pause: async () => ({ durable: true }), resume: () => new Promise(resolve => { ack = resolve; })
  } });
  r.start(r.requestConsent()); await r.append(meta(), pcm);
  await r.pause({ pauseId: 1, cutoffs: { microphone: 2, remote: 0 } });
  const pending = r.resume({ pauseId: 1, starts: { microphone: 10, remote: 8 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.state, 'resuming');
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 10 }), pcm), /paused/);
  ack({ durable: false }); await assert.rejects(pending, /ACK/);
  assert.equal(r.state, 'failed');
});

test('stopping a paused recording cannot authorize new audio beyond the pause boundary', async () => {
  const r = new Recording('meeting', { put: async () => ({ durable: true }) },
    { pauseStore: { pause: async () => ({ durable: true }) } });
  r.start(r.requestConsent()); await r.append(meta(), pcm);
  await r.pause({ pauseId: 1, cutoffs: { microphone: 2, remote: 0 } });
  assert.throws(() => r.stop({ microphone: 4, remote: 0 }), /pause boundary/);
  assert.equal(r.state, 'paused');
  r.stop({ microphone: 2, remote: 0 });
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 2 }), pcm), /cutoff/);
  await r.finish(); assert.equal(r.state, 'stopped');
});

test('explicit capture abort preserves failure after an outstanding durable write', async () => {
  let release;
  const r = setup(() => new Promise(resolve => { release = resolve; }));
  const write = r.append(meta(), pcm);
  await new Promise(resolve => setImmediate(resolve));
  r.abort('device disconnected');
  r.abort('secondary failure');
  release({ durable: true });
  await write;
  assert.equal(r.state, 'failed');
  assert.equal(r.pendingBytes, 0);
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 2 }), pcm), /device disconnected/);
  await assert.rejects(r.finish(), /device disconnected/);
});
const meta = (overrides = {}) => ({ version: 1, sessionId: 'meeting', epoch: 0, source: 'microphone', seq: 0, startFrame: 0, frames: 2, sampleRate: 48000, channels: 1, ...overrides });
function setup(put = async () => ({ durable: true }), maxPendingBytes = 16) {
  const r = new Recording('meeting', { put }, { maxPendingBytes });
  r.start(r.requestConsent());
  return r;
}

test('C01 approval token is session-bound, one-use and required', () => {
  const a = new Recording('a', {}), b = new Recording('b', {});
  assert.throws(() => a.start('invented'), /consent/);
  const token = a.requestConsent();
  assert.throws(() => b.start(token), /consent/);
  a.start(token);
  assert.throws(() => a.start(token));
});

test('C03/C12 finish awaits durable ACK for delayed pre-stop tail', async () => {
  let release;
  const r = setup(() => new Promise(resolve => { release = resolve; }));
  r.stop({ microphone: 2, remote: 0 });
  const write = r.append(meta(), pcm);
  let finished = false;
  const finish = r.finish().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(r.state, 'draining');
  release({ durable: true });
  await Promise.all([write, finish]);
  assert.equal(r.state, 'stopped');
  assert.equal(r.pendingBytes, 0);
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 2 }), pcm), /closed/);
});

test('C12 missing tail and backward cutoff cannot produce success', async () => {
  const r = setup();
  await r.append(meta(), pcm);
  assert.throws(() => r.stop({ microphone: 1, remote: 0 }), /cutoff/);
  r.stop({ microphone: 4, remote: 0 });
  await assert.rejects(r.finish(), /missing/);
  assert.equal(r.state, 'failed');
});

test('C02 rejects sequence gaps, epoch changes and changing format', async () => {
  const r = setup();
  await assert.rejects(r.append(meta({ seq: 1 }), pcm), /sequence/);
  await assert.rejects(r.append(meta({ startFrame: 1 }), pcm), /frame/);
  await assert.rejects(r.append(meta({ epoch: 1 }), pcm), /epoch/);
  await r.append(meta(), pcm);
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 2, sampleRate: 16000 }), pcm), /format/);
});

test('C03 disk failure remains failed even after late success', async () => {
  let release;
  const r = setup(m => m.source === 'microphone' ? Promise.reject(new Error('ENOSPC')) : new Promise(resolve => { release = resolve; }));
  const remote = r.append(meta({ source: 'remote' }), pcm);
  await assert.rejects(r.append(meta(), pcm), /ENOSPC/);
  release({ durable: true });
  await remote;
  assert.equal(r.state, 'failed');
  await assert.rejects(r.finish(), /failed/);
  assert.equal(r.pendingBytes, 0);
});

test('queue limit fails explicitly without scheduling excess data', async () => {
  let release, calls = 0;
  const r = setup(() => { calls++; return new Promise(resolve => { release = resolve; }); }, 4);
  const first = r.append(meta(), pcm);
  await assert.rejects(r.append(meta({ seq: 1, startFrame: 2 }), pcm), /queue/);
  assert.equal(calls, 1);
  assert.equal(r.pendingBytes, 4);
  release({ durable: true });
  await first;
  assert.equal(r.state, 'failed');
});

test('C03 non-durable store response cannot complete recording', async () => {
  const r = setup(async () => ({ durable: false }));
  await assert.rejects(r.append(meta(), pcm), /ACK/);
  assert.equal(r.state, 'failed');
});
