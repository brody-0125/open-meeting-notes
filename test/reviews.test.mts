import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReviewStore, reviewKeys } from '../src/reviews.mjs';
const input = () => ({ transcript: { revision: 1, segments: [{ id: 's1', rawText: '원문' }] }, summary: { items: [{ text: '후보', status: 'candidate' }] } });

test('reconciled reviews use final items and never inherit a per-part approval', () => {
  const r = input();
  r.summaryParts = { parts: [{ index: 0, summary: structuredClone(r.summary) }, { index: 1, summary: structuredClone(r.summary) }] };
  const previous = reviewKeys(r, 'a'.repeat(64));
  r.reconciliation = { state: 'complete' };
  const current = reviewKeys(r, 'a'.repeat(64));
  assert.equal(current.length, 1);
  assert.notEqual(current[0][0], previous[0][0]);
});
test('review identity binds transcript, summary and model without changing generated candidates', () => {
  const original = input(), before = structuredClone(original), key = reviewKeys(original, 'a'.repeat(64))[0][0];
  for (const change of [r => r.transcript.revision++, r => r.transcript.segments[0].rawText = '수정', r => r.summary.items[0].text = '새 후보']) {
    const r = input(); change(r); assert.notEqual(reviewKeys(r, 'a'.repeat(64))[0][0], key);
  }
  assert.notEqual(reviewKeys(original, 'b'.repeat(64))[0][0], key);
  assert.deepEqual(original, before);
});
test('review choices survive a new store, can be reset, and never imply review for new content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-review-')); t.after(() => rm(root, { recursive: true, force: true }));
  const key = reviewKeys(input(), 'a'.repeat(64))[0][0];
  const store = new ReviewStore(root);
  assert.equal(await store.get(key), 'candidate');
  await store.set(key, 'accepted');
  assert.equal(await new ReviewStore(root).get(key), 'accepted');
  await store.set(key, 'rejected'); assert.equal(await store.get(key), 'rejected');
  await store.set(key, 'candidate'); assert.equal(await store.get(key), 'candidate');
  assert.equal(await store.get('b'.repeat(64)), 'candidate');
});
test('invalid paths, states and damaged reviews cannot become confirmed judgments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-review-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore(root), key = 'a'.repeat(64);
  await assert.rejects(store.set('../escape', 'accepted'));
  await assert.rejects(store.set(key, 'confirmed'));
  await store.set(key, 'accepted');
  await writeFile(join(root, `${key}.json`), JSON.stringify({ version: 1, key, state: 'accepted', checksum: 'bad' }));
  await assert.rejects(store.get(key), /integrity/);
});
