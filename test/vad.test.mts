import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SileroFrames } from '../src/audio/vad.mjs';

test('Silero uses 512 samples plus 64 context, with independent source state', async () => {
  const seen = [];
  const vad = new SileroFrames(async input => {
    seen.push(input);
    return { probability: 0.75, state: new Float32Array(256).fill(input.state[0] + 1) };
  });
  await vad.process('microphone', new Float32Array(512).fill(0.2));
  await vad.process('remote', new Float32Array(512).fill(0.4));
  const result = await vad.process('microphone', new Float32Array(512).fill(0.6));
  assert.equal(seen[0].samples.length, 576);
  assert.equal(seen[0].samples[0], 0);
  assert.equal(seen[1].state[0], 0);
  assert.equal(seen[1].samples[0], 0);
  assert.equal(seen[2].state[0], 1);
  assert.equal(seen[2].samples[0], Math.fround(0.2));
  assert.deepEqual(result, { probability: 0.75, speech: true });
  vad.reset('microphone');
  await vad.process('microphone', new Float32Array(512));
  assert.equal(seen[3].state[0], 0);
  assert.equal(seen[3].samples[0], 0);
});

test('rejects malformed frames and probabilities instead of reporting silence', async () => {
  let calls = 0;
  const vad = new SileroFrames(async () => { calls++; return { probability: NaN, state: new Float32Array(256) }; });
  for (const samples of [new Float32Array(511), new Float32Array(512).fill(NaN), new Float32Array(512).fill(2)]) {
    await assert.rejects(vad.process('microphone', samples), /frame/);
  }
  await assert.rejects(vad.process('unknown', new Float32Array(512)), /source/);
  assert.equal(calls, 0);
  await assert.rejects(vad.process('microphone', new Float32Array(512)), /output/);
});

test('busy inference is bounded; failed inference clears recurrent state', async () => {
  let finish;
  const seen = [];
  let n = 0;
  const vad = new SileroFrames(async input => {
    seen.push(input);
    if (++n === 1) return { probability: 0.8, state: new Float32Array(256).fill(3) };
    if (n === 2) return new Promise((_, reject) => { finish = reject; });
    return { probability: 0, state: new Float32Array(256) };
  });
  await vad.process('microphone', new Float32Array(512).fill(0.1));
  const pending = vad.process('microphone', new Float32Array(512));
  await assert.rejects(vad.process('remote', new Float32Array(512)), /busy/);
  assert.throws(() => vad.reset('microphone'), /busy/);
  finish(new Error('runtime failure'));
  await assert.rejects(pending, /runtime failure/);
  await vad.process('microphone', new Float32Array(512));
  assert.equal(seen[2].state[0], 0);
  assert.equal(seen[2].samples[0], 0);
});
