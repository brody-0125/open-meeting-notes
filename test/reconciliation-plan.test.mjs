import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReconciliation, validateReconciliationPlan } from '../src/inference/reconciliation-plan.mjs';

const transcript = { revision: 2, segments: [{ id: 'a', rawText: '첫 결정🙂을 취소하고 다음 안건을 논의합니다.' }, { id: 'b', rawText: '예산은 미정입니다.' }] };
const count = request => 50 + JSON.parse(request.messages[1].content).transcript.reduce((n, s) => n + [...s.rawText].length, 0);

test('long reconciliation planning measures its own prompt and preserves every UTF-16 source range', async () => {
  const plan = await planReconciliation(transcript, count, { inputLimit: 60 });
  assert.ok(plan.parts.length > 1);
  validateReconciliationPlan(plan, transcript);
  for (const s of transcript.segments) {
    const pieces = plan.parts.flatMap(p => p.segments).filter(p => p.id === s.id);
    assert.equal(pieces.map(p => p.rawText).join(''), s.rawText);
    assert.equal(pieces[0].start, 0);
    assert.equal(pieces.at(-1).end, s.rawText.length);
    for (const p of pieces) assert.equal(p.rawText, s.rawText.slice(p.start, p.end));
  }
  assert.ok(plan.parts.every(p => p.segments.reduce((n, s) => n + [...s.rawText].length, 0) <= 10));
});

test('Main rejects missing, duplicate, reordered, altered or mislabeled source ranges', async () => {
  const plan = await planReconciliation(transcript, count, { inputLimit: 60 });
  for (const mutate of [
    p => p.parts.pop(), p => p.parts.reverse(), p => p.parts.push(p.parts[0]),
    p => p.parts[0].segments[0].end++, p => p.parts[0].segments[0].rawText = '변조',
    p => p.revision++, p => p.parts[0].index = 8,
    p => p.parts[0].segments[0].extra = true
  ]) { const bad = structuredClone(plan); mutate(bad); assert.throws(() => validateReconciliationPlan(bad, transcript)); }
});

test('a Worker plan may not split a surrogate pair even if joined text matches the source', () => {
  const input = { revision: 1, segments: [{ id: 'x', rawText: '🙂' }] };
  const plan = { version: 1, revision: 1, parts: [0, 1].map(i => ({ index: i,
    segments: [{ id: 'x', rawText: input.segments[0].rawText[i], start: i, end: i + 1 }] })) };
  assert.throws(() => validateReconciliationPlan(plan, input), /Unicode/);
});

test('impossible, invalid or cancelled measurements never produce a partial successful plan', async () => {
  await assert.rejects(planReconciliation(transcript, () => 99, { inputLimit: 60 }), /fit/);
  await assert.rejects(planReconciliation(transcript, () => NaN), /token/);
  await assert.rejects(planReconciliation(transcript, count, { inputLimit: 4096 }), /limit/);
  const controller = new AbortController();
  await assert.rejects(planReconciliation(transcript, () => { controller.abort(); return 1; },
    { signal: controller.signal }), { name: 'AbortError' });
});
