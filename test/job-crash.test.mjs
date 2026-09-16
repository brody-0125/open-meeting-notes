import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.mjs';
test('C09 process crash preserves completed result and retries unfinished result', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-job-crash-'));
  const child = fork(new URL('./job-crash-worker.mjs', import.meta.url), [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); });
  let committed, reached = false;
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stderr.on('data', data => reject(new Error(String(data))));
    child.on('message', message => {
      if (message.committed) committed = message.committed;
      if (message.stage === 'synced') { reached = true; child.kill('SIGKILL'); }
    });
    child.on('exit', () => reached ? resolve() : reject(new Error('checkpoint not reached')));
  });
  assert.ok(committed);
  const recovered = new JobStore(root);
  assert.deepEqual((await recovered.begin(committed)).result, { text: 'acknowledged' });
  assert.equal((await recovered.begin({ ...committed, inputHash: '4'.repeat(64) })).cached, false);
});
