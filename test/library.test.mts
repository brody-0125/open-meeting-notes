import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecordingLibrary } from '../src/library.mjs';
import { ChunkStore } from '../src/store.mjs';
import { sealRecording } from '../src/recording-seal.mjs';
const id = '11111111-1111-4111-8111-111111111111';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omn-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, library: new RecordingLibrary(root) };
}
test('listing does not claim verified completion; inspection verifies selected audio', async t => {
  const { root, library } = await fixture(t);
  const store = new ChunkStore(join(root, id));
  await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 0, startFrame: 0,
    sampleRate: 16000, frames: 16, channels: 1 }, Buffer.alloc(32));
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 16, remote: 0 } });
  const list = await library.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].state, undefined);
  const detail = await library.inspect(id);
  assert.equal(detail.state, 'complete');
  assert.equal(detail.durationSeconds, 0.001);
  assert.equal(detail.index, undefined); // No audio/index dump across renderer boundary.
});
test('incomplete directory remains visible, unknown names and traversal are rejected', async t => {
  const { root, library } = await fixture(t);
  await mkdir(join(root, id));
  await mkdir(join(root, 'unrelated'));
  assert.equal((await library.list()).length, 1);
  assert.equal((await library.inspect(id)).state, 'incomplete');
  for (const value of ['../secret', 'C:/secret', 'unrelated', null]) await assert.rejects(library.inspect(value), /id/);
});
test('junctions cannot expose recordings outside the library', async t => {
  const { root, library } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'omn-library-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, id), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await library.list(), []);
  await assert.rejects(library.inspect(id), /directory/);
});
