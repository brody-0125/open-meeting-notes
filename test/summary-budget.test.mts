import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qwenPromptParts, assertSummaryBudget, QWEN_TEMPLATE } from '../src/inference/summary-budget.mjs';
import { buildSummaryRequest } from '../src/inference/summary.mjs';

const request = () => buildSummaryRequest({ revision: 1, segments: [{ id: 's1', rawText: '검토합니다.' }] });
const config = () => ({ conv_template: structuredClone(QWEN_TEMPLATE) });

test('Qwen budget includes system, user and empty thinking reply, without joining tokenizer boundaries', () => {
  const req = request();
  const parts = qwenPromptParts(req, config());
  assert.deepEqual(parts, [
    `<|im_start|>system\n${req.messages[0].content}<|im_end|>\n`,
    `<|im_start|>user\n${req.messages[1].content}<|im_end|>\n`,
    '<|im_start|>assistant\n<think>\n\n</think>\n\n'
  ]);
});

test('unsupported templates and requests fail closed instead of estimating', () => {
  for (const mutate of [c => c.conv_template.seps = ['changed'], c => c.conv_template.system_prefix_token_ids = [1], c => c.conv_config = {}, c => c.conv_template.messages = [['user', 'history']]]) {
    const c = config(); mutate(c);
    assert.throws(() => qwenPromptParts(request(), c), /unsupported/);
  }
  for (const mutate of [r => r.extra_body.enable_thinking = true, r => r.messages.push({ role: 'user', content: 'extra' }), r => r.messages[1].content = [], r => r.tools = []]) {
    const r = request(); mutate(r);
    assert.throws(() => qwenPromptParts(r, config()), /unsupported/);
  }
});

test('output tokens are reserved and invalid measurements never reach generation', () => {
  assert.equal(assertSummaryBudget(request(), 3072), 3072);
  assert.throws(() => assertSummaryBudget(request(), 3073), /context budget/);
  for (const n of [NaN, -1, 1.5, Infinity]) assert.throws(() => assertSummaryBudget(request(), n), /token count/);
});

test('only valid measured context overflow exposes CONTEXT_LIMIT', () => {
  assert.throws(() => assertSummaryBudget(request(), 3073), { code: 'CONTEXT_LIMIT' });
  for (const tokens of [NaN, -1, 1.5]) {
    assert.throws(() => assertSummaryBudget(request(), tokens), error => error.code === undefined);
  }
  for (const max_tokens of [NaN, -1, 0, 1.5]) {
    assert.throws(() => assertSummaryBudget({ ...request(), max_tokens }, 100), error => error.code === undefined);
  }
});

test('request builder snapshots only evidence-bearing fields and retains existing input limits', () => {
  const original = { revision: 1, segments: [{ id: 's1', rawText: '원문', metadata: 'not a prompt field' }] };
  const req = buildSummaryRequest(original);
  original.segments[0].rawText = '수정';
  assert.deepEqual(JSON.parse(req.messages[1].content), { revision: 1, transcript: [{ id: 's1', rawText: '원문' }] });
  assert.throws(() => buildSummaryRequest({ revision: 1, segments: [{ id: 's1', rawText: 'x'.repeat(12001) }] }), /chunking/);
});
