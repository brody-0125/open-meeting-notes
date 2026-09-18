import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateChunk, validateSummary, Session, acceptResult } from '../src/contracts.mjs';
import { ChunkStore } from '../src/store.mjs';

const chunk = (overrides = {}) => ({ version: 1, sessionId: 'session-1', epoch: 0,
  source: 'microphone', seq: 0, startFrame: 0, frames: 2, sampleRate: 48000,
  channels: 1, ...overrides });
const pcm = Buffer.from([0, 0, 255, 127]);

test('C02 rejects shape, byte-length, source and arithmetic violations', () => {
  assert.doesNotThrow(() => validateChunk(chunk(), pcm));
  for (const bad of [{ version: 2 }, { frames: 3 }, { frames: -1 },
    { startFrame: Number.MAX_SAFE_INTEGER }, { source: 'unknown' },
    { sessionId: '../escape' }, { extra: true }, { channels: 3 }]) {
    assert.throws(() => validateChunk(chunk(bad), pcm));
  }
});

test('C01/C12 consent, stop cutoff and delayed valid tail', () => {
  const s = new Session('session-1');
  assert.throws(() => s.start(false));
  s.start(true);
  assert.throws(() => s.start(true));
  s.stop({ microphone: 4, remote: 0 });
  assert.doesNotThrow(() => s.accept(chunk(), pcm));
  assert.doesNotThrow(() => s.accept(chunk({ seq: 1, startFrame: 2 }), pcm));
  assert.throws(() => s.accept(chunk({ seq: 2, startFrame: 4 }), pcm));
  s.finish();
  assert.throws(() => s.accept(chunk(), pcm));
});

test('C06/C07 rejects cancelled, stale revision and model results', () => {
  const current = { id: 'job-1', generation: 2, revision: 3, modelHash: 'a', inputHash: 'b', settingsHash: 'c', status: 'running' };
  const result = { ...current };
  assert.equal(acceptResult(current, result), true);
  for (const change of [{ generation: 1 }, { revision: 2 }, { modelHash: 'z' }, { inputHash: 'z' }, { settingsHash: 'z' }]) {
    assert.equal(acceptResult(current, { ...result, ...change }), false);
  }
  assert.equal(acceptResult({ ...current, status: 'cancelled' }, result), false);
});

test('C08 validates exact evidence, without claiming semantic entailment', () => {
  const segments = [{ id: 's1', text: '금요일은 안 됩니다.' }];
  const summary = { version: 1, revision: 2, items: [{ kind: 'decision', text: '일정 재검토', status: 'candidate', evidence: [{ segmentId: 's1', quote: '금요일은 안 됩니다.' }] }] };
  assert.doesNotThrow(() => validateSummary(summary, segments, 2));
  assert.throws(() => validateSummary(summary, segments, 3));
  const invalid = structuredClone(summary);
  invalid.items[0].evidence[0].quote = '금요일까지 완료';
  assert.throws(() => validateSummary(invalid, segments, 2));
  invalid.items[0].evidence = [];
  assert.throws(() => validateSummary(invalid, segments, 2));
});

test('C03/C04/C09 durable ACK, idempotence, conflict and corruption detection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root);
  const ack = await store.put(chunk(), pcm);
  assert.equal(ack.durable, true);
  assert.deepEqual(await store.put(chunk(), pcm), ack);
  await assert.rejects(store.put(chunk(), Buffer.from([1, 0, 255, 127])), /conflict/);
  const recovered = await new ChunkStore(root).recover();
  assert.equal(recovered.chunks.length, 1);
  assert.deepEqual(recovered.chunks[0].pcm, pcm);
  const file = join(root, ack.file);
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(file, bytes);
  const damaged = await store.recover();
  assert.equal(damaged.chunks.length, 0);
  assert.equal(damaged.errors.length, 1);
});

test('C03 failed sync never produces ACK', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root, { checkpoint: async stage => {
    if (stage === 'written') throw new Error('injected sync failure');
  } });
  await assert.rejects(store.put(chunk(), pcm), /injected/);
  assert.equal((await new ChunkStore(root).recover()).chunks.length, 0);
});
