import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterErrors, literalChecks } from '../src/stt-quality.mjs';
test('CER counts substitutions/deletions/insertions without capping bad recognition at 100%', () => {
  assert.deepEqual(characterErrors('가 나 다.', '가라'), { edits: 2, referenceCharacters: 3, cer: 2 / 3 });
  assert.equal(characterErrors('가', '가나다라').cer, 3);
  assert.equal(characterErrors('ＡＰＩ 서버', 'api서버').cer, 0);
  assert.throws(() => characterErrors('...', 'hallucination'));
});
test('literal checks support explicit numeric spellings without pretending to verify meaning', () => {
  const checks = [{ label: '금액', anyOf: ['오백만 원', '500만 원'] }];
  assert.equal(literalChecks('500만 원입니다.', checks)[0].present, true);
  assert.equal(literalChecks('5000만 원입니다.', checks)[0].present, false);
  assert.equal(literalChecks('500만 원이 아닙니다.', checks)[0].present, true); // lexical presence only
});
