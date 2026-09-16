import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markUnconfirmedSpeech } from '../src/audio/speech-evidence.mjs';
const audio = { source: 'microphone', sampleRate: 16000, startFrame: 160000, samples: new Float32Array(32000) };
const segment = (start, end) => ({ source: 'microphone', start, end, rawText: '원문', flags: [] });
const measurement = { speechRanges: [{ startFrame: 0, endFrame: 8192 }] };
test('speech elsewhere in the clip does not confirm non-overlapping text', () => {
  const segments = [segment(10, 10.5), segment(11, 12), segment(10.512, 11), segment(10.1, 10.1)];
  const result = markUnconfirmedSpeech(segments, audio, measurement);
  assert.deepEqual(result.map(s => s.flags), [[], ['speech-unconfirmed'], ['speech-unconfirmed'], ['speech-unconfirmed']]);
  assert.deepEqual(segments.map(s => s.flags), [[], [], [], []]);
  assert.ok(result.every(s => s.rawText === '원문'));
});
test('native source time wins over rounded resampling time and missing VAD requires review', () => {
  const input = { ...audio, origin: { startFrame: 441001, sampleRate: 44100, frames: 88200 } };
  const start = input.origin.startFrame / input.origin.sampleRate;
  assert.deepEqual(markUnconfirmedSpeech([segment(start, start + .1)], input, measurement)[0].flags, []);
  assert.deepEqual(markUnconfirmedSpeech([segment(10, 11)], audio, null)[0].flags, ['speech-unconfirmed']);
});
test('malformed or out-of-clip ranges cannot establish speech evidence', () => {
  for (const speechRanges of [null, [{ startFrame: -1, endFrame: 100 }], [{ startFrame: 0, endFrame: 32001 }],
    [{ startFrame: 100, endFrame: 100 }], [{ startFrame: 10, endFrame: 20 }, { startFrame: 0, endFrame: 15 }]])
    assert.throws(() => markUnconfirmedSpeech([segment(10, 11)], audio, { speechRanges }), /measurement/);
});
