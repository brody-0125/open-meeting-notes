import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CorrectionStore } from '../src/corrections.mjs';
const base = () => ({ revision: 1, sessionId: 'session', segments: [{ id: 's1', rawText: '월요일', evidenceIds: ['s1', 'alias'] }], conflicts: [], gaps: [] });
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'omn-corrections-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('correction preserves original and aliases, persists revision, and rejects stale saves', async t => {
  const root = await fixture(t), store = new CorrectionStore(root), raw = base(), current = await store.load(raw);
  const edited = await store.save(current, 's1', '금요일');
  assert.equal(edited.revision, 2);
  assert.equal(edited.segments[0].rawText, '금요일');
  assert.equal(edited.segments[0].originalRawText, '월요일');
  assert.deepEqual(edited.segments[0].evidenceIds, ['s1', 'alias']);
  assert.deepEqual(await new CorrectionStore(root).load(raw), edited);
  assert.deepEqual(raw, base());
  await assert.rejects(store.save(current, 's1', '다른 수정'), /stale/);
  assert.deepEqual(await store.save(edited, 's1', '금요일'), edited);
  const changedBase = base(); changedBase.segments[0].rawText = '새 모델의 전사';
  assert.equal((await store.load(changedBase)).revision, 1);
});
test('invalid edits and corruption cannot silently replace original text', async t => {
  const root = await fixture(t), store = new CorrectionStore(root), current = await store.load(base());
  await assert.rejects(store.save(current, 'unknown', 'text'));
  await assert.rejects(store.save(current, 's1', 'x'.repeat(12001)));
  await store.save(current, 's1', '수정');
  await writeFile(join(root, `${current.baseHash}.json`), '{}');
  await assert.rejects(store.load(base()), /integrity/);
});
