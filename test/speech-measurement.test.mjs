import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureSpeech } from '../src/audio/vad.mjs';

test('clip measurement resets state, includes padded tail and preserves source PCM', async () => {
  const samples = new Float32Array(513).fill(.25), original = samples.slice(), seen = [], resets = [];
  const detector = { reset: source => resets.push(source), process: async (source, frame) => {
    seen.push({ source, frame }); return { probability: seen.length === 1 ? .1 : .5 };
  } };
  assert.deepEqual(await measureSpeech(detector, { source: 'remote', sampleRate: 16000, samples }),
    { frames: 2, speechFrames: 1, maximumProbability: .5, speechRanges: [{ startFrame: 512, endFrame: 513 }] });
  assert.deepEqual(resets, ['remote', 'remote']);
  assert.equal(seen[1].frame[0], .25);
  assert.ok(seen[1].frame.subarray(1).every(x => x === 0));
  assert.ok(seen.every(x => x.source === 'remote'));
  assert.deepEqual(samples, original);
});

test('speech ranges merge adjacent detections but retain non-speech gaps', async () => {
  const probabilities = [.1, .5, .9, .1, .8]; let i = 0;
  const detector = { reset() {}, process: async () => ({ probability: probabilities[i++] }) };
  assert.deepEqual(await measureSpeech(detector, { source: 'microphone', sampleRate: 16000, samples: new Float32Array(2300) }),
    { frames: 5, speechFrames: 3, maximumProbability: .9,
      speechRanges: [{ startFrame: 512, endFrame: 1536 }, { startFrame: 2048, endFrame: 2300 }] });
});

test('invalid audio is rejected before detector state changes', async () => {
  const detector = { reset() { assert.fail('must validate first'); }, process() { assert.fail(); } };
  const input = { source: 'microphone', sampleRate: 16000, samples: new Float32Array(512) };
  for (const patch of [{ source: 'unknown' }, { sampleRate: 48000 }, { samples: [] },
    { samples: new Float32Array(0) }, { samples: new Float32Array(480001) },
    { samples: Float32Array.of(NaN) }, { samples: Float32Array.of(1.01) }]) {
    await assert.rejects(measureSpeech(detector, { ...input, ...patch }), /invalid/);
  }
});

test('failed or malformed inference never produces a no-speech measurement', async () => {
  for (const probability of [NaN, -1, 1.1, undefined, '0']) {
    let resets = 0;
    const detector = { reset() { resets++; }, process: async () => ({ probability }) };
    await assert.rejects(measureSpeech(detector, { source: 'microphone', sampleRate: 16000, samples: new Float32Array(1) }), /probability/);
    assert.equal(resets, 2);
  }
  let resets = 0;
  const detector = { reset() { resets++; }, process: async () => { throw new Error('runtime lost'); } };
  await assert.rejects(measureSpeech(detector, { source: 'remote', sampleRate: 16000, samples: new Float32Array(1) }), /runtime lost/);
  assert.equal(resets, 2);
});

test('cancellation rejects before inference or after a pending frame without accepting partial measurements', async () => {
  const input = { source: 'remote', sampleRate: 16000, samples: new Float32Array(1024) };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(measureSpeech({ reset() { assert.fail(); } }, input, { signal: controller.signal }), { name: 'AbortError' });
  const active = new AbortController(); let calls = 0, resets = 0;
  const detector = { reset() { resets++; }, process: async () => { calls++; active.abort(); return { probability: 0 }; } };
  await assert.rejects(measureSpeech(detector, input, { signal: active.signal }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(resets, 2);
});
