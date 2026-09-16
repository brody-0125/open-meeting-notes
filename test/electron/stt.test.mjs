import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Whisper runs locally on synthetic speech with empty profile and no remote fetch attempts', { timeout: 120000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE, 'Set OMN_STT_FIXTURE to prepared local fixture directory');
  const root = await mkdtemp(join(tmpdir(), 'omn-stt-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const result = await page.evaluate(async () => {
    const attempts = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const raw = typeof args[0] === 'string' ? args[0] : args[0].url ?? String(args[0]);
      const url = new URL(raw, location.href);
      if (url.protocol !== 'omn:' || url.host !== 'app') { attempts.push(url.href); throw new Error('external fetch denied'); }
      return originalFetch(...args);
    };
    const { loadWhisper } = await import('/whisper.mjs');
    const wav = await (await fetch('/speech.wav')).arrayBuffer();
    const context = new AudioContext({ sampleRate: 16000 });
    const audio = await context.decodeAudioData(wav);
    const samples = audio.getChannelData(0).slice();
    await context.close();
    const model = await loadWhisper({ modelId: 'whisper-tiny' });
    let segments, silenceSegments;
    try {
      segments = await model.transcribe({ jobId: 'synthetic', source: 'microphone', startFrame: 0, sampleRate: 16000, samples }, { language: 'en' });
      silenceSegments = await model.transcribe({ jobId: 'digital-silence', source: 'remote', startFrame: 0,
        sampleRate: 16000, samples: new Float32Array(16000 * 10) }, { language: 'ko' });
    } finally { await model.dispose(); }
    const missingRejected = await loadWhisper({ modelId: 'not-installed' }).then(async unexpected => { await unexpected.dispose(); return false; }, () => true);
    return { segments, silenceSegments, attempts, missingRejected };
  });
  assert.deepEqual(result.attempts, []);
  assert.equal(result.missingRejected, true);
  assert.deepEqual(result.silenceSegments, [], 'digital silence must not create transcript evidence');
  const text = result.segments.map(s => s.rawText).join(' ').toLowerCase();
  assert.match(text, /meeting/);
  assert.match(text, /report/);
  assert.ok(result.segments.every(s => s.end >= s.start));
  t.diagnostic(`Synthetic speech transcript: ${text}`);
});
