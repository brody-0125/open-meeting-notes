import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChunkStore } from '../src/store.mjs';
import { JobStore } from '../src/jobs.mjs';
import { transcriptionJobs } from '../src/transcription-jobs.mjs';
test('sequential transcription resumes at unfinished window after new store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audio = new ChunkStore(join(root, 'audio'));
  for (let seq = 0; seq < 3; seq++) await audio.put({ version: 1, sessionId: 'meeting', source: 'microphone', epoch: 0, seq, startFrame: seq * 4, frames: 4, sampleRate: 16000, channels: 1 }, Buffer.alloc(8, seq));
  const index = await audio.index();
  const config = { sessionId: 'meeting', source: 'microphone', revision: 1, modelHash: 'a'.repeat(64), settingsHash: 'b'.repeat(64), windowFrames: 4, overlapFrames: 0 };
  let calls = [];
  const execute = async (window, { key }) => {
    calls.push(window.startFrame);
    if (window.startFrame === 4 && calls.length === 2) throw new Error('interrupted');
    return [{ id: `${key}:0`, jobId: key, source: window.source, start: window.startFrame / 16000,
      end: (window.startFrame + window.samples.length) / 16000, rawText: '전사', flags: [] }];
  };
  await assert.rejects(Array.fromAsync(transcriptionJobs(audio, index, new JobStore(join(root, 'jobs')), config, execute)), /interrupted/);
  assert.deepEqual(calls, [0, 4]);
  calls = [];
  const results = await Array.fromAsync(transcriptionJobs(audio, index, new JobStore(join(root, 'jobs')), config, execute));
  assert.deepEqual(calls, [4, 8]);
  assert.equal(results.length, 3);
  assert.equal(new Set(results.map(r => r.key)).size, 3);
  const bad = { ...config, settingsHash: 'c'.repeat(64) };
  await assert.rejects(Array.fromAsync(transcriptionJobs(audio, index, new JobStore(join(root, 'jobs')), bad,
    async (_window, { key }) => [{ id: `${key}:0`, jobId: key, source: 'remote', start: 0, end: 1, rawText: 'wrong', flags: [] }])), /transcript/);
});
