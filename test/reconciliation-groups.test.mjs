import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCandidates, validateCandidateGroups, validateGroupSummary } from '../src/inference/reconciliation-groups.mjs';
import { buildReconciliationRequest, reconcileCandidates } from '../src/inference/reconciliation.mjs';

const input = { revision: 1, transcript: [{ id: 's0', rawText: '초안을 금요일까지 보내겠습니다.' }, { id: 's1', rawText: '수신 담당자는 미정입니다.' }],
  candidates: [0, 1].map(i => ({ id: `p${i}:i0`, item: { kind: 'topic', status: 'candidate', text: '후보',
    evidence: [{ segmentId: `s${i}`, quote: i ? '수신 담당자는 미정입니다.' : '초안을 금요일까지 보내겠습니다.' }] } })) };
const plan = () => ({ version: 1, revision: 1, groups: [
  { subject: '초안 전달', kind: 'action', candidateIds: ['p0:i0'] },
  { subject: '수신 담당자', kind: 'topic', candidateIds: ['p1:i0'] }
] });
const response = (value, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] });

test('a group plan must partition every candidate exactly once without stale or invented links', () => {
  assert.doesNotThrow(() => validateCandidateGroups(plan(), input));
  for (const change of [p => p.groups.pop(), p => p.groups[1].candidateIds.push('p0:i0'),
    p => p.groups[0].candidateIds.push('unknown'), p => p.revision++, p => p.groups[0].candidateIds = [],
    p => p.groups[0].kind = 'confirmed', p => p.groups[0].subject = '', p => p.extra = true]) {
    const bad = plan(); change(bad); assert.throws(() => validateCandidateGroups(bad, input));
  }
});

test('group planning measures the request, snapshots input and rejects truncation or cancellation', async () => {
  const mutable = structuredClone(input);
  const actual = await groupCandidates(async request => {
    assert.equal(request.extra_body.enable_thinking, false);
    mutable.candidates.pop(); return response(plan());
  }, mutable, { countTokens: () => 100 });
  assert.deepEqual(actual, plan());
  await assert.rejects(groupCandidates(async () => assert.fail('must not generate'), input, { countTokens: () => 4000 }), /budget/);
  await assert.rejects(groupCandidates(async () => response(plan(), 'length'), input, { countTokens: () => 100 }), /incomplete/);
  const controller = new AbortController();
  await assert.rejects(groupCandidates(async () => { controller.abort(); return response(plan()); }, input,
    { countTokens: () => 100, signal: controller.signal }), { name: 'AbortError' });
});

test('one grouped summary must preserve its planned kind and all of its candidate evidence', () => {
  const selected = { ...input, candidates: [input.candidates[0]], transcript: [input.transcript[0]] };
  const result = { version: 1, revision: 1, items: [{ ...input.candidates[0].item, kind: 'action', candidateIds: ['p0:i0'] }] };
  assert.doesNotThrow(() => validateGroupSummary(result, selected, plan().groups[0]));
  const wrong = structuredClone(result); wrong.items[0].kind = 'topic';
  assert.throws(() => validateGroupSummary(wrong, selected, plan().groups[0]), /group/);
  assert.throws(() => validateGroupSummary({ ...result, items: [...result.items, ...result.items] }, selected, plan().groups[0]), /group/);
  const schema = JSON.parse(buildReconciliationRequest(selected, { sourceScope: 'excerpts', groupKind: 'action' }).response_format.schema);
  assert.equal(schema.properties.items.minItems, 1); assert.equal(schema.properties.items.maxItems, 1);
  assert.deepEqual(schema.properties.items.items.properties.kind, { const: 'action' });
  assert.deepEqual(Object.keys(schema.properties.items.items.properties), ['status', 'evidence', 'text', 'kind', 'candidateIds']);
  assert.equal(schema.properties.items.items.properties.candidateIds.minItems, 1);
});

test('group kind is enforced after generation as well as in the grammar', async () => {
  const selected = { ...input, candidates: [input.candidates[0]], transcript: [input.transcript[0]] };
  const result = { version: 1, revision: 1, items: [{ ...input.candidates[0].item, candidateIds: ['p0:i0'] }] };
  await assert.rejects(reconcileCandidates(async () => response(result), selected,
    { countTokens: () => 100, sourceScope: 'excerpts', groupKind: 'action' }), /group summary/);
});
