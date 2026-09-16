import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording, inspectRecording } from '../../src/recording-seal.mjs';

for (const failure of [null, 'track', 'context']) test(`real capture pause ${failure ? `detects ${failure} loss` : 'resumes through IPC and persists exact gaps'}`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-device-pause-')), audio = join(root, 'audio');
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: audio } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const result = await page.evaluate(async failure => {
    const { prepareCapture } = await import('/capture-device.mjs');
    await window.captureTest.start();
    const context = new AudioContext({ sampleRate: 48000 }), streams = {}, gains = {};
    for (const source of ['microphone', 'remote']) {
      const oscillator = new OscillatorNode(context), destination = context.createMediaStreamDestination();
      const gain = new GainNode(context, { gain: source === 'microphone' ? .5 : .1 });
      gains[source] = gain;
      oscillator.connect(gain).connect(destination); oscillator.start(); streams[source] = destination.stream;
    }
    let chunks = 0;
    const capture = await prepareCapture({ context, streams, sessionId: 'browser-test', sink: {
      ...window.captureTest, append: data => { chunks++; return window.captureTest.append(data); }
    } });
    try {
      if (capture.levels() !== null) throw new Error('idle levels must be unavailable');
      await capture.start(); await new Promise(resolve => setTimeout(resolve, 150));
      const levels = capture.levels();
      if (!(levels.microphone > .3 && levels.microphone < .4 && levels.remote > .06 && levels.remote < .08))
        throw new Error(`incorrect source levels: ${JSON.stringify(levels)}`);
      gains.remote.gain.value = 0;
      await new Promise(resolve => setTimeout(resolve, 150));
      const silent = capture.levels();
      if (silent.remote !== 0 || silent.microphone < .3) throw new Error('source silence not isolated');
      const pause = await capture.pause(), count = chunks;
      if (capture.levels() !== null) throw new Error('paused levels must be unavailable');
      if (failure) {
        if (failure === 'track') streams.remote.getAudioTracks()[0].enabled = false;
        else await context.suspend();
        const error = await capture.done.then(() => '', error => error.message);
        return { error, state: capture.state, context: context.state,
          tracks: Object.values(streams).flatMap(s => s.getTracks().map(t => t.readyState)) };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      if (chunks !== count || capture.state !== 'paused' || context.state !== 'running') throw new Error('invalid paused capture');
      const resume = await capture.resume();
      await new Promise(resolve => setTimeout(resolve, 150));
      const cutoffs = await capture.stop();
      return { pause, resume, cutoffs, state: capture.state, context: context.state };
    } finally { if (!['stopped', 'failed'].includes(capture.state)) await capture.abort('test cleanup').catch(() => {}); }
  }, failure);
  assert.equal(result.context, 'closed');
  if (failure) {
    assert.equal(result.state, 'failed'); assert.match(result.error, /unavailable/);
    assert.deepEqual(result.tracks, ['ended', 'ended']);
    assert.equal((await inspectRecording(audio)).state, 'incomplete');
  } else {
    assert.equal(result.state, 'stopped');
    const store = new ChunkStore(audio);
    await sealRecording({ store, sessionId: 'browser-test', cutoffs: result.cutoffs });
    const verified = await inspectRecording(audio);
    assert.equal(verified.state, 'complete');
    assert.deepEqual(verified.pauses, [{ ...result.pause, starts: result.resume.starts }]);
    for (const source of ['microphone', 'remote']) {
      const chunks = verified.index.chunks.filter(c => c.meta.source === source);
      assert.ok(result.resume.starts[source] > result.pause.cutoffs[source]);
      assert.ok(chunks.some(c => c.meta.startFrame === result.resume.starts[source]));
      assert.ok(chunks.every(c => c.meta.startFrame + c.meta.frames <= result.pause.cutoffs[source] || c.meta.startFrame >= result.resume.starts[source]));
    }
  }
});

test('real Worklet keeps running during pause without posting PCM and resumes on its audio clock', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-worklet-pause-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48000 });
    let oscillator, node;
    try {
      await context.audioWorklet.addModule('/capture-worklet.mjs');
      node = new AudioWorkletNode(context, 'meeting-capture', {
        processorOptions: { sessionId: 'pause-test', source: 'microphone', chunkFrames: 4800 }
      });
      oscillator = new OscillatorNode(context);
      oscillator.connect(node).connect(context.destination); oscillator.start();
      const chunks = [], waiting = new Map();
      const next = type => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`missing ${type}`)), 5000);
        waiting.set(type, data => { clearTimeout(timer); resolve(data); });
      });
      node.port.onmessage = ({ data }) => {
        if (data.type === 'chunk') { chunks.push(data.meta); node.port.postMessage({ type: 'ack', seq: data.meta.seq }); }
        const deliver = waiting.get(data.type); waiting.delete(data.type); deliver?.(data);
      };
      await context.resume();
      let pending = next('chunk'); node.port.postMessage({ type: 'start' }); await pending;
      pending = next('paused'); node.port.postMessage({ type: 'pause', pauseId: 1 });
      const paused = await pending, count = chunks.length;
      await new Promise(resolve => setTimeout(resolve, 250));
      const pausedCount = chunks.length, stateDuringPause = context.state;
      pending = next('resumed'); node.port.postMessage({ type: 'resume', pauseId: 1 });
      const resumed = await pending;
      // The first resumed chunk may have arrived in the same message batch.
      if (chunks.length === count) await next('chunk');
      pending = next('stopped'); node.port.postMessage({ type: 'stop' }); await pending;
      return { paused, resumed, count, pausedCount, stateDuringPause, before: chunks[count - 1], after: chunks[count] };
    } finally { oscillator?.stop(); node?.disconnect(); node?.port.close(); await context.close(); }
  });
  assert.equal(result.stateDuringPause, 'running');
  assert.equal(result.count, result.pausedCount);
  assert.equal(result.before.startFrame + result.before.frames, result.paused.cutoff);
  assert.ok(result.resumed.startFrame > result.paused.cutoff);
  assert.equal(result.after.startFrame, result.resumed.startFrame);
  assert.equal(result.after.seq, result.before.seq + 1);
});

test('real stopped MediaStream track fails capture and releases both sources', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-device-loss-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const result = await page.evaluate(async () => {
    const { prepareCapture } = await import('/capture-device.mjs');
    await window.captureTest.start();
    const context = new AudioContext({ sampleRate: 48000 });
    const streams = {};
    for (const source of ['microphone', 'remote']) {
      const oscillator = new OscillatorNode(context, { frequency: 440 });
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      streams[source] = destination.stream;
    }
    const capture = await prepareCapture({ context, streams, sessionId: 'browser-test', sink: window.captureTest });
    await capture.start();
    streams.remote.getAudioTracks()[0].stop();
    const error = await capture.done.then(() => '', error => error.message);
    const mainError = await window.captureTest.finish().then(() => '', error => error.message);
    return { error, mainError, state: capture.state, context: context.state,
      tracks: Object.values(streams).flatMap(stream => stream.getTracks().map(track => track.readyState)) };
  });
  assert.match(result.error, /unavailable|input/);
  assert.match(result.mainError, /failed|incomplete/);
  assert.equal(result.state, 'failed');
  assert.equal(result.context, 'closed');
  assert.deepEqual(result.tracks, ['ended', 'ended']);
});

test('two real MediaStreams → Worklets → coordinated drain → durable storage', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-electron-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const result = await page.evaluate(async () => {
    const { prepareCapture } = await import('/capture-device.mjs');
    await window.captureTest.start();
    const context = new AudioContext({ sampleRate: 48000 });
    const streams = {}, resources = [];
    const samples = { microphone: [], remote: [] };
    for (const [source, frequency] of [['microphone', 440], ['remote', 880]]) {
      const oscillator = new OscillatorNode(context, { frequency });
      const streamOutput = context.createMediaStreamDestination();
      oscillator.connect(streamOutput);
      streams[source] = streamOutput.stream;
      resources.push({ oscillator, stream: streamOutput.stream });
      oscillator.start();
    }
    const capture = await prepareCapture({ context, streams, sessionId: 'browser-test', sink: {
      ...window.captureTest,
      finish: () => {
        if (context.state !== 'closed' || resources.some(({ stream }) => stream.getTracks().some(track => track.readyState !== 'ended'))) throw new Error('capture resources still active during verification');
        return window.captureTest.finish();
      },
      append: async data => {
        samples[data.meta.source].push(...new Uint8Array(data.pcm));
        if (data.meta.source === 'remote') await new Promise(resolve => setTimeout(resolve, 15));
        return window.captureTest.append(data);
      }
    } });
    await capture.start();
    await new Promise(resolve => setTimeout(resolve, 250));
    const cutoffs = await capture.stop();
    const state = capture.state;
    const released = context.state === 'closed' && resources.every(({ stream }) => stream.getTracks().every(track => track.readyState === 'ended'));
    const remoteDenied = await fetch('https://example.invalid/probe').then(() => false, () => true);
    const micDenied = await navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }, error => error.name === 'NotAllowedError');
    return { samples, cutoffs, state, released, remoteDenied, micDenied, nodeUnavailable: typeof window.require === 'undefined' };
  });
  assert.equal(result.state, 'stopped');
  assert.equal(result.released, true);
  assert.equal(result.remoteDenied, true);
  assert.equal(result.micDenied, true);
  assert.equal(result.nodeUnavailable, true);
  const recovered = await new ChunkStore(join(root, 'audio')).recover();
  assert.deepEqual(recovered.errors, []);
  for (const source of ['microphone', 'remote']) {
    assert.ok(result.cutoffs[source] > 1024);
    assert.ok(result.samples[source].some(x => x !== 0));
    const bytes = Buffer.concat(recovered.chunks.filter(c => c.meta.source === source).sort((a, b) => a.meta.seq - b.meta.seq).map(c => c.pcm));
    assert.deepEqual(bytes, Buffer.from(result.samples[source]));
    assert.equal(bytes.length, result.cutoffs[source] * 2);
  }
  assert.notDeepEqual(result.samples.microphone, result.samples.remote);
});
