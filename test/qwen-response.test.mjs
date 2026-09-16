import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQwenResponse } from '../src/inference/qwen-response.mjs';
test('Qwen no-thinking adapter strips only an empty leading think envelope', () => {
  const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
  const original = response('<think>\n\n</think>\n{"items":[]}');
  assert.equal(normalizeQwenResponse(original).choices[0].message.content, '{"items":[]}');
  assert.ok(original.choices[0].message.content.startsWith('<think>'));
  for (const content of ['<think>reasoning</think>{}', '```json\n{}\n```', '{}'])
    assert.equal(normalizeQwenResponse(response(content)).choices[0].message.content, content);
});
