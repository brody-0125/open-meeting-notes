import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PcmChunker } from '../src/audio/pcm.mjs';

const options = { sessionId: 'audio', source: 'remote', sampleRate: 48000, chunkFrames: 4 };

test('pause commits the tail and resume preserves omitted time without fabricated PCM', () => {
  const chunks = [], c = new PcmChunker(options, chunk => chunks.push(chunk));
  c.push([Float32Array.of(1, -1)]);
  assert.equal(c.pause(), 2);
  assert.equal(chunks.length, 1);
  assert.throws(() => c.push([Float32Array.of(.5)]), /paused/);
  c.resume(48000);
  c.push([Float32Array.of(0, 1, 0)]);
  assert.equal(c.pause(), 48005);
  c.resume(24000);
  c.push([Float32Array.of(-1)]);
  assert.equal(c.stop(), 72006);
  assert.deepEqual(chunks.map(({ meta }) => [meta.seq, meta.startFrame, meta.frames]),
    [[0, 0, 2], [1, 48002, 3], [2, 72005, 1]]);
  assert.deepEqual(chunks.flatMap(chunk => [...new Int16Array(chunk.pcm)]), [32767, -32768, 0, 32767, 0, -32768]);
});

test('invalid pause transitions and elapsed frame counts leave the timeline unchanged', () => {
  const chunks = [], c = new PcmChunker(options, chunk => chunks.push(chunk));
  assert.throws(() => c.resume(1), /not paused/);
  c.push([Float32Array.of(1)]);
  assert.equal(c.pause(), 1);
  assert.throws(() => c.pause(), /paused/);
  for (const frames of [-1, .5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER])
    assert.throws(() => c.resume(frames), /pause duration/);
  c.resume(0);
  c.push([Float32Array.of(-1)]);
  assert.equal(c.stop(), 2);
  assert.deepEqual(chunks.map(chunk => chunk.meta.startFrame), [0, 1]);
  assert.throws(() => c.pause(), /stopped/);
  assert.throws(() => c.resume(0), /stopped/);
});

test('stop while paused returns the last captured boundary without another chunk', () => {
  const chunks = [], c = new PcmChunker(options, chunk => chunks.push(chunk));
  c.push([Float32Array.of(.5)]);
  c.pause();
  assert.equal(c.stop(), 1);
  assert.equal(c.stop(), 1);
  assert.equal(chunks.length, 1);
});

test('resumed capture refuses frame overflow before retaining any samples', () => {
  const chunks = [], c = new PcmChunker(options, chunk => chunks.push(chunk));
  c.pause(); c.resume(Number.MAX_SAFE_INTEGER);
  assert.throws(() => c.push([Float32Array.of(1)]), /overflow/);
  assert.equal(c.stop(), Number.MAX_SAFE_INTEGER);
  assert.deepEqual(chunks, []);
});
test('PCM16 conversion clips and averages stereo, preserving signed endpoints', () => {
  const chunks = [];
  const c = new PcmChunker(options, x => chunks.push(x));
  c.push([new Float32Array([-2, -1, 0, 1]), new Float32Array([-2, 1, 1, 2])]);
  assert.deepEqual([...new Int16Array(chunks[0].pcm)], [-32768, 0, 16384, 32767]);
  assert.equal(chunks[0].meta.channels, 1);
  assert.equal(c.stop(), 4);
  assert.equal(chunks.length, 1);
});

test('variable block partitions produce identical PCM and final tail', () => {
  function capture(sizes) {
    const chunks = [];
    const c = new PcmChunker(options, x => chunks.push(x));
    let frame = 0;
    for (const size of sizes) {
      c.push([Float32Array.from({ length: size }, () => (frame++ - 10) / 20)]);
    }
    assert.equal(c.stop(), 21);
    assert.equal(c.stop(), 21);
    assert.throws(() => c.push([new Float32Array(1)]), /stopped/);
    assert.deepEqual(chunks.map(x => x.meta.startFrame), [0, 4, 8, 12, 16, 20]);
    assert.deepEqual(chunks.map(x => x.meta.frames), [4, 4, 4, 4, 4, 1]);
    return Buffer.concat(chunks.map(x => Buffer.from(x.pcm)));
  }
  assert.deepEqual(capture([21]), capture([1, 7, 3, 2, 8]));
});

test('invalid blocks are rejected atomically and empty input is not fabricated silence', () => {
  const chunks = [];
  const c = new PcmChunker(options, x => chunks.push(x));
  for (const block of [[], [new Float32Array([0, NaN])], [new Float32Array([Infinity])],
    [new Float32Array(2), new Float32Array(1)]]) assert.throws(() => c.push(block));
  assert.equal(c.stop(), 0);
  assert.equal(chunks.length, 0);
});

test('long sequence has bounded staging storage and independent output buffers', () => {
  let count = 0, first;
  const c = new PcmChunker(options, chunk => { count++; first ??= chunk.pcm; });
  for (let i = 0; i < 1000; i++) c.push([new Float32Array([1, 0, -1, 0])]);
  assert.equal(c.stop(), 4000);
  assert.equal(count, 1000);
  assert.deepEqual([...new Int16Array(first)], [32767, 0, -32768, 0]);
});
