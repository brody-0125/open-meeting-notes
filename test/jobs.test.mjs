import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobStore, runJob, jobKey } from '../src/jobs.mjs';
const job = changes => ({ version: 1, sessionId: 'meeting', kind: 'transcribe', revision: 1,
  inputHash: '1'.repeat(64), modelHash: '2'.repeat(64), settingsHash: '3'.repeat(64), ...changes });
const validate = value => { if (!value || typeof value.text !== 'string') throw new Error('invalid result'); };
async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'omn-jobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new JobStore(root, options) };
}
test('C06 completed job reused after fresh store; dependency changes create new job', async t => {
  const { root, store } = await fixture(t);
  let calls = 0;
  const execute = async () => { calls++; return { text: '전사' }; };
  await runJob(store, job(), execute, validate);
  assert.deepEqual(await runJob(new JobStore(root), job(), execute, validate), { text: '전사' });
  assert.equal(calls, 1);
  for (const changes of [{ revision: 2 }, { modelHash: '4'.repeat(64) }, { settingsHash: '5'.repeat(64) }, { inputHash: '6'.repeat(64) }])
    assert.notEqual(jobKey(job(changes)), jobKey(job()));
});
test('C06 aborted late completion cannot overwrite retry', async t => {
  const { store } = await fixture(t);
  const old = await store.begin(job());
  store.cancel(old);
  const current = await store.begin(job());
  await assert.rejects(store.complete(old, { text: 'stale' }), /stale/);
  await store.complete(current, { text: 'current' });
  assert.equal((await store.begin(job())).result.text, 'current');
});
test('C06 failed validation never becomes reusable completion', async t => {
  const { store } = await fixture(t);
  await assert.rejects(runJob(store, job(), async () => ({ text: 123 }), validate), /invalid/);
  const lease = await store.begin(job());
  assert.equal(lease.cached, false);
  store.cancel(lease);
});
test('C09 interrupted pre-rename write is not a completed job', async t => {
  const { root, store } = await fixture(t, { checkpoint: async stage => { if (stage === 'synced') throw new Error('injected interruption'); } });
  await assert.rejects(runJob(store, job(), async () => ({ text: 'draft' }), validate), /interruption/);
  assert.equal((await new JobStore(root).begin(job())).cached, false);
});
test('C09 completed file tampering cannot be reused', async t => {
  const { root, store } = await fixture(t);
  await runJob(store, job(), async () => ({ text: 'original' }), validate);
  const path = join(root, `${jobKey(job())}.json`);
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.result.text = 'changed';
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(new JobStore(root).begin(job()), /integrity/);
});
test('C07 signal abort during generation prevents commit', async t => {
  const { store } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(runJob(store, job(), async () => { controller.abort(); return { text: 'late' }; }, validate, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await store.begin(job())).cached, false);
});
test('C07 second active request is rejected rather than racing same result file', async t => {
  const { store } = await fixture(t);
  const attempts = await Promise.allSettled([store.begin(job()), store.begin(job())]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(x => x.status === 'rejected').length, 1);
});
test('C07 cancellation after file sync is still cancellation and cannot commit', async t => {
  const controller = new AbortController();
  const { root, store } = await fixture(t, { checkpoint: async stage => { if (stage === 'synced') controller.abort(); } });
  await assert.rejects(runJob(store, job(), async () => ({ text: 'late' }), validate, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await new JobStore(root).begin(job())).cached, false);
});
