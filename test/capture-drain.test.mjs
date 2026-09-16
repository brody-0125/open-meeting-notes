import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureDrain } from '../src/audio/capture-drain.mjs';
import { Recording } from '../src/recording.mjs';
import { ChunkStore } from '../src/store.mjs';
import { sealRecording, inspectRecording } from '../src/recording-seal.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function port() {
  return { sent: [], onmessage: null, postMessage(data) { this.sent.push(data); },
    emit(data) { this.onmessage?.({ data }); } };
}
function fixture(sink = {}, options = {}) {
  const ports = { microphone: port(), remote: port() };
  const calls = [];
  const drain = new CaptureDrain(ports, {
    append: async () => ({ durable: true }), stop: async cutoffs => calls.push(['stop', cutoffs]),
    finish: async () => calls.push(['finish']), abort: async error => calls.push(['abort', error]), ...sink
  }, options);
  return { drain, ports, calls };
}
const chunk = (source, seq = 0) => ({ type: 'chunk', meta: { source, seq }, pcm: new ArrayBuffer(2) });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function pausedFixture(sink = {}, options = {}) {
  const f = fixture({ pause: async () => ({ durable: true }), ...sink }, options);
  f.drain.start(); const paused = f.drain.pause();
  for (const p of Object.values(f.ports)) p.emit({ type: 'paused', pauseId: 1, cutoff: 0 });
  await paused; await tick(); return f;
}

test('resumed PCM waits for both boundaries and durable metadata before reaching the sink', async () => {
  let ack;
  const f = await pausedFixture({ resume: record => { f.calls.push(['resume', record]); return new Promise(resolve => { ack = resolve; }); },
    append: async data => { f.calls.push(['append', data.meta.source]); return { durable: true }; } });
  const resumed = f.drain.resume();
  f.ports.microphone.emit({ type: 'resumed', pauseId: 1, startFrame: 100 });
  f.ports.microphone.emit(chunk('microphone')); await tick();
  assert.deepEqual(f.calls, []);
  f.ports.remote.emit({ type: 'resumed', pauseId: 1, startFrame: 110 }); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.drain.state, 'resuming');
  ack({ durable: true }); await resumed; await tick();
  assert.equal(f.drain.state, 'recording');
  assert.deepEqual(f.calls.map(c => c[0]), ['resume', 'append']);
  const paused = f.drain.pause();
  assert.equal(f.ports.microphone.sent.at(-1).pauseId, 2);
  for (const p of Object.values(f.ports)) p.emit({ type: 'paused', pauseId: 2, cutoff: 120 });
  await paused;
  const done = f.drain.stop(); for (const p of Object.values(f.ports)) p.emit({ type: 'stopped', cutoff: 120 }); await done;
});

test('stop during resume drains gated PCM without reverting to recording', async () => {
  let ack;
  const f = await pausedFixture({ resume: () => new Promise(resolve => { ack = resolve; }),
    append: async () => { f.calls.push(['append']); return { durable: true }; } });
  const resumed = f.drain.resume(), rejection = assert.rejects(resumed, /stopped/);
  const stopped = f.drain.stop();
  for (const [source, p] of Object.entries(f.ports)) {
    p.emit({ type: 'resumed', pauseId: 1, startFrame: 10 });
    p.emit(chunk(source)); p.emit({ type: 'stopped', cutoff: 11 });
  }
  await tick(); assert.deepEqual(f.calls, []);
  ack({ durable: true }); await rejection; await stopped;
  assert.equal(f.drain.state, 'stopped');
  assert.deepEqual(f.calls.map(c => c[0]), ['append', 'append', 'stop', 'finish']);
});

test('failed resume metadata never releases queued PCM', async () => {
  const f = await pausedFixture({ resume: async () => ({ durable: false }), append: async () => { throw new Error('must not append'); } });
  const resumed = f.drain.resume();
  const rejected = Promise.all([assert.rejects(resumed, /ACK/), assert.rejects(f.drain.done, /ACK/)]);
  for (const [source, p] of Object.entries(f.ports)) {
    p.emit({ type: 'resumed', pauseId: 1, startFrame: 10 }); p.emit(chunk(source));
  }
  await rejected; assert.equal(f.drain.state, 'failed');
});

test('coordinator pause and resume commit through Recording into a verifiable sealed recording', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-coordinated-pause-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root), recording = new Recording('meeting', store);
  recording.start(recording.requestConsent()); let cutoffs;
  const f = fixture({ append: data => recording.append(data.meta, Buffer.from(data.pcm)),
    pause: record => recording.pause(record), resume: record => recording.resume(record),
    stop: value => { cutoffs = value; recording.stop(value); },
    finish: async () => { await recording.finish(); await sealRecording({ store, sessionId: 'meeting', cutoffs }); },
    abort: reason => recording.abort(reason) });
  const emit = (source, seq, startFrame) => f.ports[source].emit({ type: 'chunk',
    meta: { version: 1, sessionId: 'meeting', epoch: 0, source, seq, startFrame, frames: 2, sampleRate: 16000, channels: 1 },
    pcm: new ArrayBuffer(4) });
  f.drain.start(); for (const source of Object.keys(f.ports)) emit(source, 0, 0);
  const paused = f.drain.pause();
  for (const p of Object.values(f.ports)) p.emit({ type: 'paused', pauseId: 1, cutoff: 2 });
  await paused;
  const resumed = f.drain.resume();
  for (const [source, startFrame] of [['microphone', 10], ['remote', 12]]) {
    f.ports[source].emit({ type: 'resumed', pauseId: 1, startFrame }); emit(source, 1, startFrame);
  }
  await resumed;
  const stopped = f.drain.stop();
  f.ports.microphone.emit({ type: 'stopped', cutoff: 12 });
  f.ports.remote.emit({ type: 'stopped', cutoff: 14 }); await stopped;
  const result = await inspectRecording(root);
  assert.equal(result.state, 'complete'); assert.equal(result.version, 2);
  assert.deepEqual(result.pauses, [{ pauseId: 1, cutoffs: { microphone: 2, remote: 2 }, starts: { microphone: 10, remote: 12 } }]);
  assert.equal(result.index.chunks.length, 4);
});

test('resume without a second source is bounded and queued audio never reaches storage', async () => {
  let calls = 0;
  const f = await pausedFixture({ resume: async () => ({ durable: true }), append: async () => { calls++; return { durable: true }; } },
    { stopTimeoutMs: 20 });
  const resumed = f.drain.resume();
  const rejected = Promise.all([assert.rejects(resumed, /timeout/), assert.rejects(f.drain.done, /timeout/)]);
  f.ports.microphone.emit({ type: 'resumed', pauseId: 1, startFrame: 10 });
  f.ports.microphone.emit(chunk('microphone')); await rejected; await tick();
  assert.equal(calls, 0); assert.equal(f.drain.state, 'failed');
});

test('pause waits for both source boundaries, audio ACK and durable pause metadata', async () => {
  let audioAck, pauseAck;
  const f = fixture({ append: () => new Promise(resolve => { audioAck = resolve; }),
    pause: record => { f.calls.push(['pause', record]); return new Promise(resolve => { pauseAck = resolve; }); } });
  f.drain.start(); const paused = f.drain.pause();
  assert.equal(f.drain.state, 'pausing');
  f.ports.microphone.emit(chunk('microphone'));
  f.ports.microphone.emit({ type: 'paused', pauseId: 1, cutoff: 1 });
  f.ports.remote.emit({ type: 'paused', pauseId: 1, cutoff: 0 });
  await tick(); assert.deepEqual(f.calls, []);
  audioAck({ durable: true }); await tick();
  assert.deepEqual(f.calls, [['pause', { pauseId: 1, cutoffs: { microphone: 1, remote: 0 } }]]);
  assert.equal(f.drain.state, 'pausing');
  pauseAck({ durable: true });
  assert.deepEqual(await paused, { pauseId: 1, cutoffs: { microphone: 1, remote: 0 } });
  assert.equal(f.drain.state, 'paused');
  const stopped = f.drain.stop();
  f.ports.microphone.emit({ type: 'stopped', cutoff: 1 });
  f.ports.remote.emit({ type: 'stopped', cutoff: 0 }); await stopped;
});

test('stop supersedes pause but waits for an already started metadata commit', async () => {
  let ack;
  const f = fixture({ pause: () => new Promise(resolve => { ack = resolve; }) });
  f.drain.start(); const paused = f.drain.pause();
  f.ports.microphone.emit({ type: 'paused', pauseId: 1, cutoff: 0 });
  f.ports.remote.emit({ type: 'paused', pauseId: 1, cutoff: 0 }); await tick();
  const stopped = f.drain.stop(); await assert.rejects(paused, /stopped/);
  f.ports.microphone.emit({ type: 'stopped', cutoff: 0 });
  f.ports.remote.emit({ type: 'stopped', cutoff: 0 }); await tick();
  assert.deepEqual(f.calls, []);
  ack({ durable: true }); await stopped;
  assert.equal(f.drain.state, 'stopped');
});

test('stop before pause acknowledgments accepts ordered late boundaries without committing pause', async () => {
  const f = fixture({ pause: async () => { throw new Error('must not commit'); } });
  f.drain.start(); const paused = f.drain.pause(), stopped = f.drain.stop();
  await assert.rejects(paused, /stopped/);
  for (const p of Object.values(f.ports)) {
    p.emit({ type: 'paused', pauseId: 1, cutoff: 0 }); p.emit({ type: 'stopped', cutoff: 0 });
  }
  await stopped; assert.equal(f.drain.state, 'stopped');
});

test('pause rejects missing durable metadata acknowledgment and absent source responses', async () => {
  for (const missingSource of [false, true]) {
    const f = fixture({ pause: async () => ({ durable: false }) }, { stopTimeoutMs: 20 });
    f.drain.start(); const paused = f.drain.pause();
    const assertions = Promise.all([assert.rejects(paused, /durable|timeout/), assert.rejects(f.drain.done, /durable|timeout/)]);
    f.ports.microphone.emit({ type: 'paused', pauseId: 1, cutoff: 0 });
    if (!missingSource) f.ports.remote.emit({ type: 'paused', pauseId: 1, cutoff: 0 });
    await assertions; assert.equal(f.drain.state, 'failed');
  }
});

test('stale or duplicate pause boundaries and PCM after a pause boundary fail closed', async () => {
  for (const kind of ['stale', 'duplicate', 'late-audio']) {
    const f = fixture({ pause: async () => ({ durable: true }) });
    f.drain.start(); const paused = f.drain.pause();
    const rejected = Promise.all([assert.rejects(paused), assert.rejects(f.drain.done)]);
    f.ports.microphone.emit({ type: 'paused', pauseId: kind === 'stale' ? 2 : 1, cutoff: 0 });
    if (kind === 'duplicate') f.ports.microphone.emit({ type: 'paused', pauseId: 1, cutoff: 0 });
    if (kind === 'late-audio') f.ports.microphone.emit(chunk('microphone'));
    await rejected;
    assert.ok(!f.calls.some(call => call[0] === 'finish'));
  }
});

test('a late metadata ACK cannot revive a timed-out pause', async () => {
  let ack;
  const f = fixture({ pause: () => new Promise(resolve => { ack = resolve; }) }, { stopTimeoutMs: 20 });
  f.drain.start(); const paused = f.drain.pause();
  const rejected = Promise.all([assert.rejects(paused, /timeout/), assert.rejects(f.drain.done, /timeout/)]);
  for (const p of Object.values(f.ports)) p.emit({ type: 'paused', pauseId: 1, cutoff: 0 });
  await rejected; ack({ durable: true }); await tick();
  assert.equal(f.drain.state, 'failed');
  assert.ok(!f.calls.some(call => call[0] === 'finish'));
});

test('final verification has a separate deadline and capture resources release before it', async () => {
  let finish, released = false;
  const f = fixture({ finish: () => {
    assert.equal(released, true);
    return new Promise(resolve => { finish = resolve; });
  } }, { stopTimeoutMs: 20, finalizeTimeoutMs: 500, onDrained: async () => { released = true; } });
  f.drain.start();
  const stopped = f.drain.stop();
  f.ports.microphone.emit({ type: 'stopped', cutoff: 0 });
  f.ports.remote.emit({ type: 'stopped', cutoff: 0 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.drain.state, 'draining');
  assert.equal(released, true);
  finish();
  await stopped;
  assert.equal(f.drain.state, 'stopped');
});

test('finalization timeout reports uncertain completion and ignores a late acknowledgement', async () => {
  let finish;
  const f = fixture({ finish: () => new Promise(resolve => { finish = resolve; }) }, { finalizeTimeoutMs: 20 });
  f.drain.start();
  const stopped = f.drain.stop();
  f.ports.microphone.emit({ type: 'stopped', cutoff: 0 });
  f.ports.remote.emit({ type: 'stopped', cutoff: 0 });
  await assert.rejects(stopped, /completion must be checked/);
  finish();
  await tick();
  assert.equal(f.drain.state, 'failed');
});

test('both tails and durable writes precede stop/finish; stop is idempotent', async () => {
  let ack;
  const f = fixture({ append: () => new Promise(resolve => { ack = resolve; }) });
  f.drain.start();
  assert.deepEqual(f.ports.microphone.sent, [{ type: 'start' }]);
  const stopped = f.drain.stop();
  assert.equal(f.drain.stop(), stopped);
  f.ports.microphone.emit(chunk('microphone'));
  f.ports.microphone.emit({ type: 'stopped', cutoff: 1 });
  f.ports.remote.emit({ type: 'stopped', cutoff: 0 });
  await tick();
  assert.deepEqual(f.calls, []);
  ack({ durable: true });
  assert.deepEqual(await stopped, { microphone: 1, remote: 0 });
  assert.deepEqual(f.calls, [['stop', { microphone: 1, remote: 0 }], ['finish']]);
  assert.deepEqual(f.ports.microphone.sent.at(-1), { type: 'ack', seq: 0 });
});

test('failed write stops both ports, reports incomplete recording, never finishes', async () => {
  const f = fixture({ append: async () => { throw new Error('disk full'); } });
  f.drain.start();
  f.ports.remote.emit(chunk('remote'));
  await assert.rejects(f.drain.done, /disk full/);
  assert.equal(f.drain.state, 'failed');
  assert.equal(f.calls[0][0], 'abort');
  assert.ok(Object.values(f.ports).every(p => p.sent.at(-1).type === 'stop'));
  assert.ok(!f.calls.some(c => c[0] === 'finish'));
});

test('missing stop callback times out without claiming success', async () => {
  const f = fixture({}, { stopTimeoutMs: 20 });
  f.drain.start();
  const stopped = f.drain.stop();
  f.ports.microphone.emit({ type: 'stopped', cutoff: 0 });
  await assert.rejects(stopped, /timeout/);
  assert.equal(f.drain.state, 'failed');
});

test('source spoof, tail after cutoff and processor failure reject the session', async () => {
  for (const kind of ['spoof', 'late', 'processor']) {
    const f = fixture();
    f.drain.start();
    if (kind === 'spoof') f.ports.remote.emit(chunk('microphone'));
    if (kind === 'processor') f.ports.remote.emit({ type: 'capture-error', message: 'input lost' });
    if (kind === 'late') {
      f.drain.stop();
      f.ports.remote.emit({ type: 'stopped', cutoff: 0 });
      f.ports.remote.emit(chunk('remote'));
    }
    await assert.rejects(f.drain.done);
    assert.equal(f.drain.state, 'failed');
  }
});

test('pending writes are bounded even for a faulty sender', async () => {
  const f = fixture({ append: () => new Promise(() => {}) }, { maxPendingChunks: 2 });
  f.drain.start();
  for (let i = 0; i < 3; i++) f.ports.microphone.emit(chunk('microphone', i));
  await assert.rejects(f.drain.done, /queue/);
});

test('drain timeout also covers a stalled durable write and prevents late completion', async () => {
  let ack;
  const f = fixture({ append: () => new Promise(resolve => { ack = resolve; }) }, { stopTimeoutMs: 20 });
  f.drain.start();
  f.ports.microphone.emit(chunk('microphone'));
  const stopped = f.drain.stop();
  f.ports.microphone.emit({ type: 'stopped', cutoff: 1 });
  f.ports.remote.emit({ type: 'stopped', cutoff: 0 });
  await assert.rejects(stopped, /timeout/);
  ack({ durable: true });
  await tick();
  assert.equal(f.drain.state, 'failed');
  assert.ok(!f.calls.some(c => c[0] === 'finish'));
});
