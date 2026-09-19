import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeChunk } from '../src/inference/transcription.mjs';
const input = () => ({ jobId: 'j1', source: 'microphone', startFrame: 16000, sampleRate: 16000, samples: new Float32Array(32000).fill(.1) });

test('exact digital silence yields no evidence while quiet nonzero audio still reaches recognition', async () => {
  const silent = { ...input(), samples: new Float32Array(32000) };
  assert.deepEqual(await transcribeChunk(() => assert.fail('must not recognize all-zero audio'), silent), []);
  const quiet = { ...silent, samples: silent.samples.slice() }; quiet.samples[10] = 1e-8;
  let calls = 0;
  await transcribeChunk(async () => { calls++; return { text: '' }; }, quiet);
  assert.equal(calls, 1, 'no arbitrary energy threshold may erase quiet speech');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transcribeChunk(() => assert.fail('cancelled'), silent, { signal: controller.signal }), { name: 'AbortError' });
});
test('looping non-speech hallucination is not kept as transcript evidence', async () => {
  const text = Array.from({ length: 40 }, (_, i) => i % 2 ? '3.' : '2.').join(' ');
  assert.deepEqual(await transcribeChunk(async () => ({ chunks: [{ text, timestamp: [0, 1] }] }), input()), []);
  assert.equal((await transcribeChunk(async () => ({ chunks: [{ text: '회의를 시작합니다', timestamp: [0.2, 1.8] }] }), input()))[0].rawText, '회의를 시작합니다');
});
test('C05 rejects incorrect rate, oversize and non-finite audio before inference', async () => {
  let calls = 0;
  const run = async () => { calls++; };
  for (const bad of [{ sampleRate: 48000 }, { samples: new Float32Array(480001) }, { samples: new Float32Array([NaN]) }])
    await assert.rejects(transcribeChunk(run, { ...input(), ...bad }));
  assert.equal(calls, 0);
});
test('C06 preserves source, original offset and immutable raw text', async () => {
  const result = await transcribeChunk(async () => ({ text: '회의 시작', chunks: [{ text: '회의 시작', timestamp: [0.2, 1.8] }] }), input());
  assert.deepEqual(result, [{ id: 'j1:0', jobId: 'j1', source: 'microphone', start: 1.2, end: 2.8, rawText: '회의 시작', flags: [] }]);
});
test('C06 marks model timestamp extending beyond audio and rejects reversed intervals', async () => {
  const result = await transcribeChunk(async () => ({ text: 'test', chunks: [{ text: 'test', timestamp: [0, null] }] }), input());
  assert.equal(result[0].end, 3);
  assert.deepEqual(result[0].flags, ['estimated-end']);
  await assert.rejects(transcribeChunk(async () => ({ chunks: [{ text: 'test', timestamp: [1, 0.5] }] }), input()), /timestamp/);
});
test('C06 cancellation discards late inference result', async () => {
  const controller = new AbortController();
  await assert.rejects(transcribeChunk(async () => { controller.abort(); return { text: 'late' }; }, input(), { signal: controller.signal }), /abort/i);
});
test('C05 resampled audio retains exact original frame offset', async () => {
  const audio = { ...input(), startFrame: 16000, origin: { startFrame: 48001, sampleRate: 48000, frames: 96000 } };
  const segments = await transcribeChunk(async () => ({ chunks: [{ text: 'test', timestamp: [0, null] }] }), audio);
  assert.equal(segments[0].start, 48001 / 48000);
  assert.equal(segments[0].end, 48001 / 48000 + 2);
  await assert.rejects(transcribeChunk(async () => ({}), { ...audio, origin: { ...audio.origin, frames: 3 } }), /origin/);
});
