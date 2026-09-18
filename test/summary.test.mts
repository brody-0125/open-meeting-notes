import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTranscript, summarySchema, buildSummaryRequest } from '../src/inference/summary.mjs';
const input = () => ({ revision: 2, segments: [{ id: 's1', rawText: '민수가 금요일까지 보고서를 작성한다.' }] });
const valid = () => ({ version: 1, revision: 2, items: [{ kind: 'action', text: '민수의 보고서 작성', status: 'candidate', evidence: [{ segmentId: 's1', quote: '민수가 금요일까지 보고서를 작성한다.' }] }] });
const response = (value, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] });

test('summary grammar produces evidence and text before selecting the claim kind', () => {
  assert.deepEqual(Object.keys(summarySchema(1).properties.items.items.properties), ['evidence', 'text', 'kind', 'status']);
});

test('summary grammar permits only source evidence IDs, including production-format IDs', () => {
  const segments = ['microphone:0:0:0', 'remote:0:1:0'].map(id => ({ id, rawText: '자료를 검토합니다.' }));
  const request = buildSummaryRequest({ revision: 1, segments });
  const schema = JSON.parse(request.response_format.schema);
  assert.deepEqual(schema.properties.items.items.properties.evidence.items.properties.segmentId,
    { type: 'string', enum: segments.map(s => s.id) });
  const empty = JSON.parse(buildSummaryRequest({ revision: 1, segments: [] }).response_format.schema);
  assert.equal(empty.properties.items.maxItems, 0);
});
test('C07/C08 accepts only evidence-linked candidate summary for the input revision', async () => {
  assert.deepEqual(await summarizeTranscript(async () => response(valid()), input()), valid());
  for (const mutate of [s => s.revision = 1, s => s.items[0].status = 'confirmed', s => s.items[0].evidence[0].segmentId = 'invented', s => s.items[0].evidence[0].quote = '월요일까지 작성']) {
    const bad = valid(); mutate(bad);
    await assert.rejects(summarizeTranscript(async () => response(bad), input()));
  }
});
test('C08 rejects truncated generation even when content happens to parse', async () => {
  await assert.rejects(summarizeTranscript(async () => response(valid(), 'length'), input()), /incomplete/);
});

test('evidence failures distinguish missing IDs and changed quotations without exposing text', async () => {
  for (const [evidence, message] of [
    [{ segmentId: 'private-id', quote: 'private-quote' }, 'invalid evidence: unknown segment'],
    [{ segmentId: 's1', quote: 'private-quote' }, 'invalid evidence: quote mismatch'],
    [{ segmentId: 's1', quote: '' }, 'invalid evidence: empty quote']
  ]) {
    const bad = valid(); bad.items[0].evidence = [evidence];
    await assert.rejects(summarizeTranscript(async () => response(bad), input()), { message });
  }
});
test('C07 input snapshot cannot be changed while generation is in flight', async () => {
  const original = input();
  const result = await summarizeTranscript(async request => {
    assert.equal(request.extra_body.enable_thinking, false);
    original.segments[0].rawText = 'edited';
    original.revision = 3;
    return response(valid());
  }, original);
  assert.equal(result.revision, 2);
});
test('C07 rejects duplicate IDs and oversize transcript before calling model', async () => {
  let calls = 0;
  const generate = async () => { calls++; };
  await assert.rejects(summarizeTranscript(generate, { revision: 1, segments: [{ id: 'same', rawText: 'a' }, { id: 'same', rawText: 'b' }] }));
  await assert.rejects(summarizeTranscript(generate, { revision: 1, segments: [{ id: 'x', rawText: 'a'.repeat(12001) }] }));
  assert.equal(calls, 0);
});
test('C07 cancel discards completed response', async () => {
  const controller = new AbortController();
  await assert.rejects(summarizeTranscript(async () => { controller.abort(); return response(valid()); }, input(), { signal: controller.signal }), /abort/i);
});
