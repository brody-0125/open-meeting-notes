import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

test('known non-speech signals must not become Korean transcript evidence', { timeout: 120000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_VAD_FIXTURE);
  const root = await mkdtemp(join(tmpdir(), 'omn-non-speech-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.evaluate(async () => {
    const { loadWhisper } = await import('/whisper.mjs');
    globalThis.nonSpeechModel = await loadWhisper({ modelId: 'whisper-tiny' });
    const { loadSilero } = await import('/silero.mjs');
    globalThis.speechDetector = await loadSilero();
  });
  for (const kind of ['hum-60hz', 'quiet-white-noise', 'quiet-speech']) await t.test(kind, async () => {
    const { segments, maximumProbability, speechFrames, frames } = await page.evaluate(async kind => {
      let samples = new Float32Array(16000 * 10);
      let state = 123456789;
      for (let i = 0; i < samples.length; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        samples[i] = kind === 'hum-60hz' ? .002 * Math.sin(2 * Math.PI * 60 * i / 16000) :
          .0003 * (2 * state / 4294967296 - 1);
      }
      if (kind === 'quiet-speech') {
        const context = new AudioContext({ sampleRate: 16000 });
        const audio = await context.decodeAudioData(await (await fetch('/speech.wav')).arrayBuffer());
        samples = audio.getChannelData(0).slice().map(x => x * .02); await context.close();
      }
      const { measureSpeech } = await import('/silero.mjs');
      const measurement = await measureSpeech(speechDetector, { source: 'remote', sampleRate: 16000, samples });
      const segments = await nonSpeechModel.transcribe({ jobId: kind, source: 'remote', startFrame: 0, sampleRate: 16000, samples },
        { language: kind === 'quiet-speech' ? 'en' : 'ko' });
      return { segments, ...measurement };
    }, kind);
    t.diagnostic(JSON.stringify({ kind, maximumProbability, speechFrames, frames, segments: segments.length, text: segments.map(s => s.rawText).join(' ').slice(0, 300) }));
    if (kind === 'quiet-speech') assert.match(segments.map(s => s.rawText).join(' '), /report/i);
    else assert.deepEqual(segments, [], 'synthetic non-speech must not create evidence');
  });
  await page.evaluate(async () => { await nonSpeechModel.dispose(); await speechDetector.dispose(); });
});
