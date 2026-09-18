import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRecording } from '../src/recording-seal.mjs';
import { ChunkStore } from '../src/store.mjs';

for (const stage of ['written', 'synced', 'renamed']) test(`completion recovery after actual process kill at ${stage}`, { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-seal-crash-'));
  const child = fork(new URL('./seal-crash-worker.mjs', import.meta.url), [root, stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); });
  let reached = false;
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stderr.on('data', data => reject(new Error(String(data))));
    child.on('message', message => { if (message.stage === stage) { reached = true; child.kill('SIGKILL'); } });
    child.on('exit', () => reached ? resolve() : reject(new Error('checkpoint not reached')));
  });
  const result = await inspectRecording(root);
  assert.equal(result.state, stage === 'renamed' ? 'complete' : 'incomplete');
  const index = await new ChunkStore(root).index();
  assert.equal(index.chunks.length, 2);
  assert.deepEqual(index.errors, []);
});
