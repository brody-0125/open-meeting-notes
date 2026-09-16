import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

test('actual VAD evidence in a mixed clip does not confirm distant noise text', { timeout: 60000 }, async t => {
  for (const key of ['OMN_STT_FIXTURE', 'OMN_SUMMARY_FIXTURE', 'OMN_VAD_FIXTURE']) assert.ok(process.env[key], key);
  const directory = await mkdtemp(join(tmpdir(), 'omn-mixed-speech-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const wav = await readFile(join(process.env.OMN_STT_FIXTURE, 'speech.wav'));
  const result = await page.evaluate(async bytes => {
    const context = new AudioContext({ sampleRate: 16000 });
    const buffer = await context.decodeAudioData(new Uint8Array(bytes).buffer);
    const speech = buffer.getChannelData(0).slice(); await context.close();
    const samples = new Float32Array(5 * 16000 + speech.length + 5 * 16000);
    let seed = 123456789;
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = .0003 * (2 * seed / 4294967296 - 1);
    }
    samples.set(speech, 5 * 16000);
    const audio = { source: 'microphone', sampleRate: 16000, startFrame: 160000, samples };
    const { InferenceClient } = await import('/inference-client.mjs');
    const { markUnconfirmedSpeech } = await import('/speech-evidence.mjs');
    const models = await window.meeting.models(), client = new InferenceClient();
    try {
      const measurement = await client.run('measure-speech', { audio, modelHash: models.vad.modelHash });
      const first = measurement.speechRanges[0];
      if (!first) throw new Error('actual speech not detected');
      const segments = [
        { source: 'microphone', start: 11, end: 12, rawText: '합성 잡음 위치의 가상 전사', flags: [] },
        { source: 'microphone', start: 10 + first.startFrame / 16000,
          end: 10 + first.endFrame / 16000, rawText: '발화 위치의 가상 전사', flags: [] },
        { source: 'microphone', start: 10 + samples.length / 16000 - 2,
          end: 10 + samples.length / 16000 - 1, rawText: '끝 잡음 위치의 가상 전사', flags: [] }
      ];
      return { measurement, flags: markUnconfirmedSpeech(segments, audio, measurement).map(s => s.flags) };
    } finally { client.dispose(); }
  }, [...wav]);
  assert.ok(result.measurement.speechFrames > 0);
  assert.deepEqual(result.flags, [['speech-unconfirmed'], [], ['speech-unconfirmed']]);
  t.diagnostic(JSON.stringify(result));
});
