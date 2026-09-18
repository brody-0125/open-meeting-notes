import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
test('live 48 kHz streams become continuous 16 kHz VAD frames; backlog never stops recording tracks', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-vad-capture-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))], env: { ...process.env,
    OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio'), OMN_STT_FIXTURE: '', OMN_SUMMARY_FIXTURE: '', OMN_VAD_FIXTURE: '' } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const result = await (await app.firstWindow()).evaluate(async () => {
    const { prepareVadCapture } = await import('/vad-capture.mjs');
    const parent = new AudioContext({ sampleRate: 48000 }), streams = {}, oscillators = [];
    for (const [source, hz] of [['microphone', 500], ['remote', 1000]]) {
      const oscillator = parent.createOscillator(), destination = parent.createMediaStreamDestination();
      oscillator.frequency.value = hz; oscillator.connect(destination); oscillator.start();
      streams[source] = destination.stream; oscillators.push(oscillator);
    }
    await parent.resume();
    const frames = { microphone: [], remote: [] }, failures = [];
    let release, startedAt, done;
    const enough = new Promise(resolve => { done = resolve; });
    const capture = await prepareVadCapture({ streams, onFailure: error => { failures.push(error.message); done(); },
      onFrame: async frame => { frames[frame.source].push({ startFrame: frame.startFrame, at: frame.capturedAt, values: [...frame.samples] });
        if (Object.values(frames).every(f => f.length >= 8)) done(); } });
    startedAt = performance.now(); await capture.start(); await enough; await capture.stop();
    const states = Object.values(streams).map(s => s.getAudioTracks()[0].readyState);
    let overflow;
    const failed = new Promise(resolve => { release = resolve; });
    const stall = await prepareVadCapture({ streams, onFrame: () => new Promise(() => {}), onFailure: error => { overflow = error.message; release(); } });
    await stall.start(); await failed; await stall.stop();
    const stillLive = Object.values(streams).every(s => s.getAudioTracks()[0].readyState === 'live');
    const parentState = parent.state;
    for (const oscillator of oscillators) oscillator.stop();
    for (const stream of Object.values(streams)) for (const track of stream.getTracks()) track.stop();
    await parent.close();
    return { frames, failures, states, stillLive, parentState, overflow, startedAt };
  });
  assert.deepEqual(result.failures, []);
  for (const [source, hz] of [['microphone', 500], ['remote', 1000]]) {
    const frames = result.frames[source]; assert.ok(frames.length >= 8);
    frames.forEach((frame, i) => { assert.equal(frame.startFrame, i * 512); assert.equal(frame.values.length, 512); assert.ok(frame.at >= result.startedAt - 32); });
    // After graph warmup, the expected tone has high energy in the 16 kHz samples.
    const values = frames.slice(3).flatMap(f => f.values);
    let sin = 0, cos = 0;
    values.forEach((v, i) => { sin += v * Math.sin(2 * Math.PI * hz * i / 16000); cos += v * Math.cos(2 * Math.PI * hz * i / 16000); });
    assert.ok(2 * Math.hypot(sin, cos) / values.length > 0.7);
  }
  assert.deepEqual(result.states, ['live', 'live']);
  assert.equal(result.stillLive, true); assert.equal(result.parentState, 'running');
  assert.match(result.overflow, /backlog/);
});
