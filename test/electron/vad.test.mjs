import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Worker Silero detects synthetic speech, isolates silent source and drives silence policy', { timeout: 60000 }, async t => {
  assert.ok(process.env.OMN_VAD_FIXTURE && process.env.OMN_STT_FIXTURE, 'Prepare VAD and speech fixtures');
  const root = await mkdtemp(join(tmpdir(), 'omn-vad-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_SUMMARY_FIXTURE: '', OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const result = await page.evaluate(async () => {
    const attempts = [];
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url ?? String(args[0]), location.href);
      if (url.protocol !== 'omn:' || url.host !== 'app') { attempts.push(url.href); throw new Error('external fetch denied'); }
      return fetchOriginal(...args);
    };
    const { InferenceClient } = await import('/inference-client.mjs');
    const { SilencePolicy } = await import('/silence.mjs');
    const context = new AudioContext({ sampleRate: 16000 });
    const audio = await context.decodeAudioData(await (await fetch('/speech.wav')).arrayBuffer());
    const samples = audio.getChannelData(0).slice();
    await context.close();
    let client = new InferenceClient(); await client.run('vad-load', {});
    const vad = {
      process: (source, samples) => client.run('vad', { source, samples }),
      async reset() { client.dispose(); client = new InferenceClient(); await client.run('vad-load', {}); },
      dispose: () => client.dispose()
    };
    const speech = [], silent = [];
    const zero = new Float32Array(512);
    try {
      for (let i = 0; i + 512 <= samples.length; i += 512) {
        speech.push((await vad.process('microphone', samples.slice(i, i + 512))).probability);
        silent.push((await vad.process('remote', zero)).probability);
      }
      await vad.reset();
      // Accelerated policy clock; this is not a real-time endurance test.
      const policy = new SilencePolicy({ silenceMs: 320, warningMs: 64, freshnessMs: 100 });
      let warning, stopped = false;
      for (let i = 0; i < 20; i++) {
        for (const source of ['microphone', 'remote']) {
          const output = await vad.process(source, zero);
          policy.observe(source, { at: i * 32, speech: output.speech, healthy: true });
        }
        const state = policy.evaluate(i * 32);
        if (state.type === 'warning') warning = state;
        if (warning && policy.confirm(warning.token, i * 32)) { stopped = true; break; }
      }
      return { speechFrames: speech.filter(x => x >= 0.5).length, totalFrames: speech.length,
        silentMax: Math.max(...silent), stopped, attempts };
    } finally { await vad.dispose(); }
  });
  assert.deepEqual(result.attempts, []);
  assert.ok(result.speechFrames > result.totalFrames * 0.3, JSON.stringify(result));
  assert.ok(result.silentMax < 0.5, JSON.stringify(result));
  assert.equal(result.stopped, true);
  t.diagnostic(JSON.stringify(result));
});
