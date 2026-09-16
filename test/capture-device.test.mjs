import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareCapture } from '../src/audio/capture-device.mjs';

class Track extends EventTarget {
  readyState = 'live'; enabled = true; muted = false; kind = 'audio';
  stop() { this.readyState = 'ended'; }
}
class Node extends EventTarget {
  disconnected = false;
  port = { onmessage: null, close() {}, postMessage: data => {
    if (data.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'stopped', cutoff: 0 } }));
  } };
  connect() { return this; }
  disconnect() { this.disconnected = true; }
}
function setup(t) {
  const previous = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = Node;
  t.after(() => { globalThis.AudioWorkletNode = previous; });
  const tracks = [new Track(), new Track()];
  const streams = Object.fromEntries(['microphone', 'remote'].map((source, i) => [source, {
    getAudioTracks: () => [tracks[i]], getTracks: () => [tracks[i]]
  }]));
  const context = new EventTarget();
  Object.assign(context, { state: 'suspended', sampleRate: 48000, destination: {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => new Node(),
    resume: async () => { context.state = 'running'; },
    close: async () => { context.state = 'closed'; } });
  const calls = [];
  const sink = { append: async () => ({ durable: true }), stop: async () => {},
    finish: async () => calls.push('finish'), abort: async () => calls.push('abort') };
  return { context, streams, tracks, sink, calls, sessionId: 'device-test' };
}

test('prepared capture starts only on request and releases owned resources after drain', async t => {
  const f = setup(t);
  const capture = await prepareCapture(f);
  assert.equal(capture.state, 'idle');
  await capture.start();
  assert.equal(capture.state, 'recording');
  await capture.stop();
  assert.equal(capture.state, 'stopped');
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.equal(f.context.state, 'closed');
  assert.deepEqual(f.calls, ['finish']);
});

test('track ended/muted and suspended audio fail rather than counting as silence', async t => {
  for (const event of ['ended', 'mute', 'suspended']) {
    const f = setup(t);
    const capture = await prepareCapture(f);
    await capture.start();
    if (event === 'suspended') {
      f.context.state = 'suspended'; f.context.dispatchEvent(new Event('statechange'));
    } else f.tracks[1].dispatchEvent(new Event(event));
    await assert.rejects(capture.done, /unavailable/);
    assert.equal(capture.state, 'failed');
    assert.ok(f.tracks.every(track => track.readyState === 'ended'));
    assert.deepEqual(f.calls, ['abort']);
  }
});

test('setup failure stops all supplied tracks and closes context', async t => {
  const f = setup(t);
  f.context.audioWorklet.addModule = async () => { throw new Error('module unavailable'); };
  await assert.rejects(prepareCapture(f), /module unavailable/);
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.equal(f.context.state, 'closed');
  assert.deepEqual(f.calls, ['abort']);
});

test('device resources close while Main is still verifying the saved recording', async t => {
  const f = setup(t);
  let release;
  f.sink.finish = () => new Promise(resolve => { release = resolve; });
  const capture = await prepareCapture(f);
  await capture.start();
  const stopping = capture.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.state, 'draining');
  assert.equal(f.context.state, 'closed');
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  release();
  await stopping;
  assert.equal(capture.state, 'stopped');
});

test('invalid or disabled source is rejected before creating a graph', async t => {
  const f = setup(t);
  f.tracks[0].enabled = false;
  await assert.rejects(prepareCapture(f), /unavailable/);
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
});
