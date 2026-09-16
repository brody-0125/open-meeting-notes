import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionSummary, summarizePartitions, validateSummaryPartitions } from '../src/inference/summary-partition.mjs';
const count = input => 4 + input.segments.reduce((n, s) => n + [...s.rawText].length + 2, 0);

test('Main validates exact ordered coverage of split IDs, including empty original segments', () => {
  const input = { revision: 1, segments: [{ id: 'a', rawText: 'abcd' }, { id: 'b', rawText: '' }] };
  const valid = [{ revision: 1, segments: [{ id: 'a', rawText: 'ab' }] }, { revision: 1, segments: [{ id: 'a', rawText: 'cd' }, { id: 'b', rawText: '' }] }];
  validateSummaryPartitions(valid, input);
  for (const mutate of [p => p.pop(), p => p.reverse(), p => p[0].revision++, p => p[0].segments[0].rawText = 'aX', p => p[0].segments[0].id = 'b', p => p.push(p[1])]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.throws(() => validateSummaryPartitions(invalid, input));
  }
});

test('partition preserves ordered text and evidence IDs within measured token limits', async () => {
  const input = { revision: 7, segments: [{ id: 'a', rawText: '가나다라마바사🙂🙂🙂🙂🙂🙂' }, { id: 'b', rawText: 'next' }] };
  const original = structuredClone(input);
  const parts = await partitionSummary(input, count, { maxTokens: 12 });
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => count(p) <= 12 && p.revision === 7));
  for (const segment of input.segments) assert.equal(parts.flatMap(p => p.segments).filter(s => s.id === segment.id).map(s => s.rawText).join(''), segment.rawText);
  assert.deepEqual(input, original);
  assert.ok(parts.flatMap(p => p.segments).every(s => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(s.rawText)));
});
test('segment and character limits apply independently of tokenizer counts', async () => {
  const input = { revision: 1, segments: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, rawText: 'abc' })) };
  const parts = await partitionSummary(input, () => 1, { maxTokens: 20, maxSegments: 2, maxChars: 5 });
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.flatMap(p => p.segments), input.segments);
});
test('impossible context, invalid token counts and duplicate IDs fail without dropping text', async () => {
  const input = { revision: 1, segments: [{ id: 's', rawText: 'word' }] };
  await assert.rejects(partitionSummary(input, () => 100, { maxTokens: 10 }), /fit/);
  await assert.rejects(partitionSummary(input, () => NaN), /token/);
  await assert.rejects(partitionSummary({ ...input, segments: [...input.segments, ...input.segments] }, count), /segment/);
});
test('cancelled planning stops asking the tokenizer for more measurements', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(partitionSummary({ revision: 1, segments: [{ id: 's', rawText: 'long input' }] }, async () => {
    calls++; controller.abort(); return 99;
  }, { signal: controller.signal, maxTokens: 12 }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a failed partition preserves valid results but cannot report whole-summary completion', async () => {
  const parts = [0, 1].map(i => ({ revision: 1, segments: [{ id: `s${i}`, rawText: `quote${i}` }] }));
  const result = await summarizePartitions(parts, async (part, index) => ({ version: 1, revision: 1, items: [{
    kind: 'topic', status: 'candidate', text: 'Candidate', evidence: [{ segmentId: part.segments[0].id, quote: index === 1 ? 'invented' : 'quote0' }]
  }] }));
  assert.equal(result.state, 'partial');
  assert.equal(result.parts.length, 1);
  assert.equal(result.failedPart, 1);
});

test('all partitions remain separate candidates, and cancellation is propagated', async () => {
  const parts = [{ revision: 1, segments: [{ id: 's', rawText: 'text' }] }];
  const result = await summarizePartitions(parts, async () => ({ version: 1, revision: 1, items: [] }));
  assert.equal(result.state, 'complete');
  assert.equal(result.parts.length, 1);
  const controller = new AbortController();
  await assert.rejects(summarizePartitions(parts, async () => { controller.abort(); return {}; }, { signal: controller.signal }), { name: 'AbortError' });
});
