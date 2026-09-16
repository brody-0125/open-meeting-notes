import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Recording } from '../../src/recording.mjs';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording, inspectRecording } from '../../src/recording-seal.mjs';
import { pcmWindows } from '../../src/audio/windows.mjs';
import { exportRecoveredAudio } from '../../src/recovery-export.mjs';

// Accelerated volume/continuity test, not a two-hour wall-clock device soak.
test('two hours of dual-source PCM survive durable storage, reopen and bounded window reading', { timeout: 300000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-volume-'));
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = performance.now(), sessionId = 'two-hour-volume';
  // Default PcmChunker cadence is one second; exercise the largest supported rate.
  const sampleRate = 48000, chunkFrames = sampleRate, totalFrames = sampleRate * 120 * 60;
  const store = new ChunkStore(root), recording = new Recording(sessionId, store);
  const pcm = Buffer.alloc(chunkFrames * 2);
  const expectedAudio = { microphone: createHash('sha256'), remote: createHash('sha256') };
  let acknowledgements = 0, sampledMaxRss = 0, maxPendingBytes = 0;
  const sampleMemory = () => { sampledMaxRss = Math.max(sampledMaxRss, process.memoryUsage().rss); };
  recording.start(recording.requestConsent());
  for (let seq = 0; seq < totalFrames / chunkFrames; seq++) {
    const startFrame = seq * chunkFrames;
    for (const [source, sign] of [['microphone', 1], ['remote', -1]]) {
      for (let i = 0; i < chunkFrames; i++) pcm.writeInt16LE(sign * ((startFrame + i) % 32760 + 1), i * 2);
      const writing = recording.append({ version: 1, sessionId, epoch: 0, source, seq, startFrame,
        frames: chunkFrames, sampleRate, channels: 1 }, pcm);
      maxPendingBytes = Math.max(maxPendingBytes, recording.pendingBytes);
      const ack = await writing; assert.equal(ack.durable, true); acknowledgements++;
      expectedAudio[source].update(pcm);
      assert.equal(recording.pendingBytes, 0); sampleMemory();
    }
    if ((seq + 1) % 1200 === 0) console.log(JSON.stringify({ stage: 'stored', simulatedMinutes: (seq + 1) / 60, acknowledgements }));
  }
  const cutoffs = { microphone: totalFrames, remote: totalFrames };
  recording.stop(cutoffs); await recording.finish();
  assert.equal(recording.state, 'stopped');
  // No completion marker yet: recover only durable audio without sealing it.
  const memoryTimer = setInterval(sampleMemory, 100);
  let recovered;
  try { recovered = await exportRecoveredAudio({ root, directory: join(root, 'exports'), sessionId }); }
  finally { clearInterval(memoryTimer); }
  const recovery = JSON.parse(await readFile(join(recovered.path, 'recovery.json'), 'utf8'));
  assert.equal(recovery.originalState, 'incomplete'); assert.equal(recovery.spans.length, 2);
  assert.deepEqual(recovery.errors, []); assert.deepEqual(recovery.partials, []);
  for (const span of recovery.spans) {
    assert.equal(span.startFrame, 0); assert.equal(span.frames, totalFrames);
    assert.equal(span.sampleRate, sampleRate); assert.equal(span.channels, 1);
    const path = join(recovered.path, span.file), file = await open(path, 'r');
    const header = Buffer.alloc(44);
    try { assert.equal((await file.read(header, 0, 44, 0)).bytesRead, 44); } finally { await file.close(); }
    assert.equal(header.readUInt32LE(40), totalFrames * 2);
    assert.equal((await stat(path)).size, 44 + totalFrames * 2);
    const actual = createHash('sha256');
    for await (const bytes of createReadStream(path, { start: 44, highWaterMark: 65536 })) { actual.update(bytes); sampleMemory(); }
    assert.equal(actual.digest('hex'), expectedAudio[span.source].digest('hex'), 'every exported PCM byte must match the recorded source');
  }
  assert.equal((await inspectRecording(root)).state, 'incomplete');
  console.log(JSON.stringify({ stage: 'recovered', spans: recovery.spans.length, pcmBytes: totalFrames * 4 }));
  await sealRecording({ store, sessionId, cutoffs });
  const inspected = await inspectRecording(root);
  assert.equal(inspected.state, 'complete'); assert.equal(inspected.chunks, 14400);
  assert.deepEqual(inspected.cutoffs, cutoffs);
  assert.ok(inspected.index.chunks.every(c => !Object.hasOwn(c, 'pcm')));
  sampleMemory();
  const counts = {};
  for (const [source, sign] of [['microphone', 1], ['remote', -1]]) {
    let windows = 0, previousEnd = 0;
    for await (const window of pcmWindows(new ChunkStore(root), inspected.index, { sessionId, source })) {
      assert.equal(window.startFrame, windows * sampleRate * 28);
      assert.equal(window.source, source); assert.equal(window.sampleRate, sampleRate);
      assert.ok(window.samples.length <= sampleRate * 30);
      if (windows) assert.equal(window.startFrame, previousEnd - sampleRate * 2);
      // Check every sample, including chunk crossings, window overlaps and final tail.
      for (let i = 0; i < window.samples.length; i++) {
        if (window.samples[i] * 32768 !== sign * ((window.startFrame + i) % 32760 + 1)) {
          assert.fail(`sample mismatch: ${source} frame ${window.startFrame + i}`);
        }
      }
      previousEnd = window.startFrame + window.samples.length; windows++; sampleMemory();
    }
    assert.equal(previousEnd, totalFrames); assert.equal(windows, 258); counts[source] = windows;
  }
  assert.equal(acknowledgements, 14400); assert.equal(maxPendingBytes, chunkFrames * 2);
  t.diagnostic(JSON.stringify({ mode: 'accelerated-volume', simulatedMinutes: 120, sources: 2, sampleRate,
    pcmBytes: totalFrames * 2 * 2, recoverySpans: recovery.spans.length, recoveryByteHashesMatched: true,
    acknowledgements, windows: counts, maxPendingBytes, sampledMaxRss,
    elapsedSeconds: (performance.now() - started) / 1000 }));
});
