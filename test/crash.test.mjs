import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChunkStore } from '../src/store.mjs';

for (const stage of ['written', 'synced', 'closed', 'renamed', 'committed']) {
  test(`C03/C09 actual process kill at ${stage} preserves acknowledged bytes`, { timeout: 10000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'omn-crash-'));
    const child = fork(new URL('./crash-worker.mjs', import.meta.url), [root, stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(async () => { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); });
    const acks = [];
    let reached = false;
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stderr.on('data', data => reject(new Error(data.toString())));
      child.on('message', message => {
        if (message.ack) acks.push(message.ack);
        if (message.stage === stage) { reached = true; child.kill('SIGKILL'); }
      });
      child.on('exit', () => reached ? resolve() : reject(new Error('worker exited before checkpoint')));
    });
    assert.equal(acks.length, 1);
    const recovered = await new ChunkStore(root).recover();
    assert.equal(recovered.errors.length, 0);
    const acknowledged = recovered.chunks.find(c => c.file === acks[0].file);
    assert.ok(acknowledged);
    assert.equal(acknowledged.checksum, acks[0].checksum);
    assert.deepEqual(acknowledged.pcm, Buffer.from([0, 0, 1, 0]));
    assert.equal(recovered.chunks.length, ['renamed', 'committed'].includes(stage) ? 2 : 1);
    const again = await new ChunkStore(root).recover();
    assert.deepEqual(again, recovered);
  });
}
