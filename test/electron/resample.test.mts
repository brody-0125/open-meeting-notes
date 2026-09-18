import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
test('real Web Audio resampling preserves duration and source origin; rejects invalid input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-resample-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))], env: { ...process.env,
    OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio'), OMN_STT_FIXTURE: '', OMN_SUMMARY_FIXTURE: '' } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const results = await page.evaluate(async () => {
    const { prepareSttAudio } = await import('/resample.mjs');
    const results = [];
    for (const rate of [16000, 44100, 48000]) {
      const samples = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / rate) * 0.5);
      const audio = await prepareSttAudio({ sampleRate: rate, samples, source: 'remote', startFrame: rate * 7 + 1 }, 'resample');
      let squared = 0;
      for (let i = 100; i < audio.samples.length - 100; i++) {
        const expected = Math.sin(2 * Math.PI * 1000 * i / 16000) * 0.5;
        squared += (audio.samples[i] - expected) ** 2;
      }
      results.push({ length: audio.samples.length, error: Math.sqrt(squared / (audio.samples.length - 200)), origin: audio.origin, startFrame: audio.startFrame });
    }
    let rejected = false;
    try { await prepareSttAudio({ sampleRate: 48000, samples: new Float32Array([NaN]), startFrame: 0 }, 'bad'); } catch { rejected = true; }
    return { results, rejected };
  });
  assert.equal(results.rejected, true);
  for (const [i, rate] of [16000, 44100, 48000].entries()) {
    const result = results.results[i];
    assert.equal(result.length, 16000);
    assert.ok(result.error < 0.01, `resampling error ${result.error}`);
    assert.deepEqual(result.origin, { startFrame: rate * 7 + 1, sampleRate: rate, frames: rate });
    assert.equal(result.startFrame, Math.round((rate * 7 + 1) * 16000 / rate));
  }
});
