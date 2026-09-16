import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconciliationInput, validateReconciliation, reconcileCandidates, buildReconciliationRequest } from '../src/inference/reconciliation.mjs';

const transcript = { revision: 3, segments: [
  { id: 'early', rawText: '회의는 화요일에 엽니다.' },
  { id: 'late', rawText: '화요일 결정을 취소합니다. 목요일에 엽니다.' },
  { id: 'unselected', rawText: '담당자는 아직 정하지 않았습니다.' }
] };
const item = (index, text) => ({ kind: 'decision', status: 'candidate', text,
  evidence: [{ segmentId: transcript.segments[index].id, quote: transcript.segments[index].rawText }] });
const parts = { state: 'complete', total: 2, parts: [
  { index: 0, summary: { version: 1, revision: 3, items: [item(0, '화요일 회의')] } },
  { index: 1, summary: { version: 1, revision: 3, items: [item(1, '목요일 회의')] } }
] };
const result = () => ({ version: 1, revision: 3, items: [{
  kind: 'decision', status: 'candidate', text: '화요일 결정을 취소하고 목요일에 회의한다.',
  evidence: [...item(0, '').evidence, ...item(1, '').evidence], candidateIds: ['p0:i0', 'p1:i0']
}] });

test('reconciliation bounds fresh quotations without making candidate evidence impossible to preserve', () => {
  const input = { revision: 1, transcript: [{ id: 's', rawText: '가'.repeat(400) }], candidates: [] };
  const quoteSchema = value => JSON.parse(buildReconciliationRequest(value).response_format.schema)
    .properties.items.items.properties.evidence.items.anyOf[0].properties.quote;
  assert.equal(quoteSchema(input).maxLength, 240);
  const output = { version: 1, revision: 1, items: [{ kind: 'topic', status: 'candidate', text: '논의', candidateIds: [],
    evidence: [{ segmentId: 's', quote: '가'.repeat(241) }] }] };
  assert.throws(() => validateReconciliation(output, input), /quote too long/);
  input.candidates.push({ id: 'p0:i0', item: { kind: 'topic', status: 'candidate', text: '논의',
    evidence: [{ segmentId: 's', quote: input.transcript[0].rawText }] } });
  assert.equal(quoteSchema(input).maxLength, 400);
  output.items[0].evidence[0].quote = input.transcript[0].rawText;
  output.items[0].candidateIds = ['p0:i0'];
  assert.doesNotThrow(() => validateReconciliation(output, input));
});

test('reconciliation grammar pairs source IDs with literal excerpts and bounds Unicode chunks', () => {
  const input = { revision: 1, transcript: [
    { id: 'repeat', rawText: '아직 미정입니다. '.repeat(100) },
    { id: 'emoji', rawText: '😀'.repeat(300) },
    { id: 'other', rawText: '금요일에 진행합니다.' }
  ], candidates: [] };
  const alternatives = JSON.parse(buildReconciliationRequest(input).response_format.schema)
    .properties.items.items.properties.evidence.items.anyOf;
  assert.equal(alternatives.length, 3);
  for (const option of alternatives) {
    const source = input.transcript.find(s => s.id === option.properties.segmentId.const);
    assert.ok(source);
    for (const quote of option.properties.quote.enum) {
      assert.ok(source.rawText.includes(quote));
      assert.ok(Array.from(quote).length <= 240);
      assert.equal(quote.includes('\uFFFD'), false);
    }
  }
  assert.deepEqual(alternatives[0].properties.quote.enum, ['아직 미정입니다.']);
  assert.deepEqual(alternatives[1].properties.quote.enum.map(q => Array.from(q).length), [240, 60]);
  assert.throws(() => validateReconciliation({ version: 1, revision: 1, items: [{ kind: 'topic', status: 'candidate',
    text: '논의', candidateIds: [], evidence: [{ segmentId: 'repeat', quote: '아직' }] }] }, input), /quote not offered/);
});

test('reconciliation retains all original text, including text omitted by per-part candidates', () => {
  const input = reconciliationInput(transcript, parts);
  assert.deepEqual(input.transcript, transcript.segments);
  assert.deepEqual(input.candidates.map(c => c.id), ['p0:i0', 'p1:i0']);
  input.transcript[0].rawText = 'changed';
  input.candidates[0].item.text = 'changed';
  assert.equal(transcript.segments[0].rawText, '회의는 화요일에 엽니다.');
  assert.equal(parts.parts[0].summary.items[0].text, '화요일 회의');
});

test('excerpt reconciliation declares its source scope and rejects unknown scopes', async () => {
  const input = reconciliationInput(transcript, parts);
  await reconcileCandidates(async request => {
    assert.match(request.messages[0].content, /전체 원문이 아니라/);
    assert.doesNotMatch(request.messages[0].content, /^전체 회의 전사와/);
    assert.deepEqual(Object.keys(JSON.parse(request.response_format.schema).properties.items.items.properties),
      ['evidence', 'text', 'kind', 'candidateIds', 'status']);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result()) } }] };
  }, input, { sourceScope: 'excerpts', countTokens: () => 100 });
  assert.throws(() => buildReconciliationRequest(input, { sourceScope: 'unknown' }), /source scope/);
});

test('later cancellation can reconcile both candidates with exact original evidence, still awaiting review', () => {
  const input = reconciliationInput(transcript, parts);
  const summary = validateReconciliation(result(), input);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].status, 'candidate');
  assert.equal(Object.hasOwn(summary.items[0], 'candidateIds'), false);
  assert.equal(summary.items[0].evidence.length, 2);
});

test('rejects missing or invented candidate coverage, stale revision, invented quotes, and automatic approval', () => {
  const input = reconciliationInput(transcript, parts);
  for (const mutate of [
    r => r.items[0].candidateIds.pop(),
    r => r.items[0].candidateIds.push('p2:i0'),
    r => r.items[0].candidateIds.push('p0:i0'),
    r => r.revision++,
    r => r.items[0].evidence[1].quote = '금요일에 엽니다.',
    r => r.items[0].status = 'accepted',
    r => r.items[0].evidence.shift(),
    r => r.items = [],
    r => r.extra = true,
    r => r.items[0].extra = true
  ]) {
    const invalid = result(); mutate(invalid);
    assert.throws(() => validateReconciliation(invalid, input));
  }
});

test('cannot reconcile partial, missing, reordered or stale partition results', () => {
  for (const mutate of [
    p => p.state = 'partial', p => p.parts.pop(), p => p.parts.reverse(),
    p => p.parts[1].summary.revision++, p => p.total = 3
  ]) {
    const invalid = structuredClone(parts); mutate(invalid);
    assert.throws(() => reconciliationInput(transcript, invalid));
  }
  assert.throws(() => reconciliationInput({ ...transcript, segments: [...transcript.segments, transcript.segments[0]] }, parts));
});

test('new findings must cite raw text, and empty inputs cannot introduce invented claims', () => {
  const input = reconciliationInput(transcript, parts), output = result();
  output.items.push({ kind: 'topic', status: 'candidate', text: '담당자 미정', candidateIds: [],
    evidence: [{ segmentId: 'unselected', quote: '담당자는 아직 정하지 않았습니다.' }] });
  assert.equal(validateReconciliation(output, input).items.length, 2);
  const empty = reconciliationInput({ revision: 3, segments: [] }, { state: 'complete', total: 0, parts: [] });
  assert.deepEqual(validateReconciliation({ version: 1, revision: 3, items: [] }, empty).items, []);
  assert.throws(() => validateReconciliation(output, empty));
});

test('coverage and exact quotations do not claim semantic entailment', () => {
  const wrongMeaning = result();
  wrongMeaning.items[0].text = '火曜日の会議が最終決定です。';
  // Structural checks cannot judge meaning; the independent semantic corpus must catch this.
  assert.doesNotThrow(() => validateReconciliation(wrongMeaning, reconciliationInput(transcript, parts)));
});

test('generation uses an immutable complete input and preserves candidate provenance', async () => {
  const input = reconciliationInput(transcript, parts);
  const output = await reconcileCandidates(async request => {
    const data = JSON.parse(request.messages[1].content);
    assert.equal(data.transcript[2].rawText, '담당자는 아직 정하지 않았습니다.');
    assert.deepEqual(Object.keys(data.candidates[0]), ['id', 'evidence']);
    assert.deepEqual(data.candidates[0].evidence, parts.parts[0].summary.items[0].evidence);
    assert.equal(JSON.parse(request.response_format.schema).properties.items.items.properties.candidateIds.type, 'array');
    input.transcript[1].rawText = 'mutated';
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result()) } }] };
  }, input, { countTokens: () => 100 });
  assert.deepEqual(output, result());
});

test('oversize or invalid measured budget rejects before generation instead of truncating', async () => {
  for (const tokens of [3073, NaN, -1]) {
    await assert.rejects(reconcileCandidates(() => assert.fail('must not generate'),
      reconciliationInput(transcript, parts), { countTokens: () => tokens }), /budget|token/);
  }
});

test('truncated, malformed and candidate-omitting output cannot become a validated result', async () => {
  for (const response of [
    { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(result()) } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ version: 1, revision: 3, items: [] }) } }] }
  ]) await assert.rejects(reconcileCandidates(async () => response,
    reconciliationInput(transcript, parts), { countTokens: () => 100 }));
});

test('only a length stop exposes a recoverable output-limit code', async () => {
  for (const reason of ['length', 'content_filter', undefined]) {
    await assert.rejects(reconcileCandidates(async () => ({ choices: [{ finish_reason: reason,
      message: { content: JSON.stringify(result()) } }] }), reconciliationInput(transcript, parts), { countTokens: () => 100 }),
    error => reason === 'length' ? error.code === 'OUTPUT_LIMIT' : error.code === undefined);
  }
});

test('cancellation during measurement and generation discards late completion', async () => {
  const measuring = new AbortController();
  await assert.rejects(reconcileCandidates(() => assert.fail('must not generate'), reconciliationInput(transcript, parts), {
    signal: measuring.signal, countTokens: async () => { measuring.abort(); return 100; }
  }), { name: 'AbortError' });
  const generating = new AbortController();
  await assert.rejects(reconcileCandidates(async () => {
    generating.abort(); return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result()) } }] };
  }, reconciliationInput(transcript, parts), { signal: generating.signal, countTokens: () => 100 }), { name: 'AbortError' });
});

test('malformed prepared inputs fail before tokenizer or model access', async () => {
  for (const mutate of [
    input => input.candidates.push(input.candidates[0]),
    input => input.transcript.push(input.transcript[0]),
    input => input.candidates[0].item.evidence[0].quote = 'invented',
    input => input.extra = 'injected',
    input => input.candidates[0].id = '../escape'
  ]) {
    const input = reconciliationInput(transcript, parts); mutate(input);
    await assert.rejects(reconcileCandidates(() => assert.fail('no generation'), input,
      { countTokens: () => assert.fail('no tokenization') }));
  }
});

test('generation schema selects candidate and source IDs before writing claims', () => {
  const schema = JSON.parse(buildReconciliationRequest(reconciliationInput(transcript, parts)).response_format.schema);
  const properties = schema.properties.items.items.properties;
  assert.deepEqual(Object.keys(properties).slice(0, 2), ['candidateIds', 'evidence']);
  assert.ok(Object.keys(properties).indexOf('text') < Object.keys(properties).indexOf('kind'));
  assert.deepEqual(properties.candidateIds.items.enum, ['p0:i0', 'p1:i0']);
  assert.deepEqual(properties.evidence.items.anyOf.map(o => o.properties.segmentId.const), ['early', 'late', 'unselected']);
});
