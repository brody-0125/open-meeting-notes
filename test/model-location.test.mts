import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelBase, inferenceKey } from '../src/inference/model-location.mjs';

test('different approved packs have disjoint tensor, tokenizer and runtime cache URLs', () => {
  const a = modelBase('a'.repeat(64)), b = modelBase('b'.repeat(64));
  for (const asset of ['models/qwen/resolve/main/tensor-cache.json', 'models/qwen/resolve/main/tokenizer.json', 'runtime/qwen.wasm']) {
    assert.notEqual(new URL(asset, a).href, new URL(asset, b).href);
    assert.equal(new URL(asset, a).protocol, 'omn:');
  }
  assert.notEqual(inferenceKey('summarize', { modelHash: 'a'.repeat(64) }), inferenceKey('summarize', { modelHash: 'b'.repeat(64) }));
  assert.equal(inferenceKey('vad-load', { modelHash: 'a'.repeat(64) }), inferenceKey('vad', { modelHash: 'a'.repeat(64) }));
  assert.equal(inferenceKey('measure-speech', { modelHash: 'a'.repeat(64) }), inferenceKey('vad', { modelHash: 'a'.repeat(64) }));
  assert.notEqual(inferenceKey('vad', { modelHash: 'a'.repeat(64) }), inferenceKey('vad', { modelHash: 'b'.repeat(64) }));
  assert.notEqual(inferenceKey('vad', { modelHash: 'a'.repeat(64) }), inferenceKey('summarize', { modelHash: 'a'.repeat(64) }));
  assert.notEqual(inferenceKey('transcribe', { modelHash: 'a'.repeat(64), modelId: 'whisper-tiny' }), inferenceKey('transcribe', { modelHash: 'b'.repeat(64), modelId: 'whisper-tiny' }));
});
test('invalid hash never becomes a resource URL or model identity', () => {
  for (const value of ['', '../model', 'https://host/', null, 42]) {
    assert.throws(() => modelBase(value), /hash/);
    assert.throws(() => inferenceKey('summarize', { modelHash: value }), /hash/);
  }
  // Isolated older smoke harness only; product registers no unversioned summary routes.
  assert.equal(modelBase(undefined), 'omn://app/');
});
