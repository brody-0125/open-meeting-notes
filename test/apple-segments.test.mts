import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appleChunksToSegments } from '../src/inference/apple-segments.mjs';

test('apple chunks become job-bound segments', () => {
  const audio = { jobId: 'job-1', source: 'microphone', startFrame: 16000, sampleRate: 16000,
    samples: new Float32Array(32000).fill(0.01) };
  const segments = appleChunksToSegments([{ text: '회의', start: 0.2, end: 1.0 }], audio, 'job-1');
  assert.deepEqual(segments, [{ id: 'job-1:0', jobId: 'job-1', source: 'microphone', start: 1.2, end: 2, rawText: '회의', flags: [] }]);
});
