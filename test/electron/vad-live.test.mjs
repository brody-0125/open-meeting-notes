import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('live audio → dedicated Worker Silero → healthy silence warning uses capture timestamps', { timeout: 30000 }, async t => {
  assert.ok(process.env.OMN_VAD_FIXTURE);
  const approval = JSON.parse(await readFile(join(process.env.OMN_VAD_FIXTURE, 'fixture-approval.json'), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'omn-vad-live-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))], env: { ...process.env,
    OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio'), OMN_STT_FIXTURE: '', OMN_SUMMARY_FIXTURE: '' } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const result = await (await app.firstWindow()).evaluate(async modelHash => {
    const { InferenceClient } = await import('/inference-client.mjs');
    const { prepareVadCapture } = await import('/vad-capture.mjs');
    const { SilencePolicy } = await import('/silence.mjs');
    const client = new InferenceClient();
    await client.run('vad-load', { modelHash }); // Load before the bounded realtime stream starts.
    const parent = new AudioContext({ sampleRate: 48000 }), streams = {}, oscillators = [];
    for (const source of ['microphone', 'remote']) {
      const oscillator = parent.createOscillator(), gain = parent.createGain(), destination = parent.createMediaStreamDestination();
      gain.gain.value = 0; oscillator.connect(gain).connect(destination); oscillator.start();
      oscillators.push(oscillator); streams[source] = destination.stream;
    }
    await parent.resume();
    // Shortened durations, real monotonic clock (not the production 180s/30s policy).
    const policy = new SilencePolicy({ silenceMs: 400, warningMs: 200, freshnessMs: 200 });
    let finish, reject, count = 0, warningSeen = false, ageMax = 0;
    const done = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
    const timer = setTimeout(() => reject(new Error('live VAD did not reach warning/confirmation')), 10000);
    const capture = await prepareVadCapture({ streams, onFailure: reject, onFrame: async (frame, signal) => {
      const output = await client.run('vad', { modelHash, source: frame.source, samples: frame.samples }, { signal });
      signal.throwIfAborted(); count++;
      ageMax = Math.max(ageMax, performance.now() - frame.capturedAt);
      policy.observe(frame.source, { at: frame.capturedAt, healthy: true, speech: output.speech });
      const state = policy.evaluate(performance.now());
      if (state.type === 'warning') { warningSeen = true; if (policy.confirm(state.token, performance.now())) finish(); }
    } });
    try {
      await capture.start(); await done;
      await capture.stop(); client.dispose();
      return { count, warningSeen, ageMax, tracksLive: Object.values(streams).every(s => s.getAudioTracks()[0].readyState === 'live') };
    } finally {
      clearTimeout(timer); await capture.stop(); client.dispose();
      oscillators.forEach(o => o.stop()); Object.values(streams).forEach(s => s.getTracks().forEach(t => t.stop())); await parent.close();
    }
  }, approval.manifestHash);
  assert.ok(result.count >= 30); assert.equal(result.warningSeen, true); assert.equal(result.tracksLive, true);
  t.diagnostic(JSON.stringify(result));
});
