import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recording } from '../src/recording.mjs';
import { ChunkStore } from '../src/store.mjs';

test('two-source reference PCM survives recording, draining and fresh-store recovery byte-for-byte', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root);
  const recording = new Recording('reference', store);
  recording.start(recording.requestConsent());
  const references = {};
  // Different signed patterns make source swapping and frame repetition visible.
  for (const [source, sign] of [['microphone', 1], ['remote', -1]]) {
    const bytes = Buffer.alloc(1200);
    for (let frame = 0; frame < 600; frame++) bytes.writeInt16LE(sign * (frame * 31 % 32767), frame * 2);
    references[source] = bytes;
  }
  const jobs = [];
  let offset = 0;
  for (const [seq, frames] of [128, 128, 128, 128, 88].entries()) {
    if (seq === 4) recording.stop({ microphone: 600, remote: 600 });
    for (const source of ['remote', 'microphone']) {
      jobs.push(recording.append({ version: 1, sessionId: 'reference', epoch: 0, source, seq,
        startFrame: offset, frames, sampleRate: 48000, channels: 1 },
      references[source].subarray(offset * 2, (offset + frames) * 2)));
    }
    offset += frames;
  }
  await recording.finish();
  const acks = await Promise.all(jobs);
  assert.equal(acks.length, 10);
  assert.equal(recording.state, 'stopped');
  const recovered = await new ChunkStore(root).recover();
  assert.deepEqual(recovered.errors, []);
  assert.deepEqual(recovered.partials, []);
  for (const source of ['microphone', 'remote']) {
    const chunks = recovered.chunks.filter(c => c.meta.source === source).sort((a, b) => a.meta.seq - b.meta.seq);
    assert.equal(chunks.length, 5);
    assert.deepEqual(Buffer.concat(chunks.map(c => c.pcm)), references[source]);
    assert.deepEqual(chunks.map(c => c.meta.startFrame), [0, 128, 256, 384, 512]);
  }
});
