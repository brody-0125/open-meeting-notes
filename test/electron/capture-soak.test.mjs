import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording, inspectRecording } from '../../src/recording-seal.mjs';

const durationMs = Number(process.env.OMN_CAPTURE_SOAK_MS ?? 60000);
assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 1000 && durationMs <= 7200000);

test('wall-clock synthetic capture preserves every emitted chunk under delayed storage ACKs', { timeout: durationMs + 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-capture-soak-')), audio = join(root, 'audio');
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: audio } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const result = await page.evaluate(async durationMs => {
    const { prepareCapture } = await import('/capture-device.mjs');
    await captureTest.start();
    const context = new AudioContext({ sampleRate: 48000 }), streams = {}, entries = [];
    for (const [source, frequency] of [['microphone', 431], ['remote', 877]]) {
      const tone = new OscillatorNode(context, { frequency }), out = context.createMediaStreamDestination();
      tone.connect(out); tone.start(); streams[source] = out.stream;
    }
    let pending = 0, maxPending = 0;
    const capture = await prepareCapture({ context, streams, sessionId: 'browser-test', sink: {
      ...captureTest,
      append: async chunk => {
        const began = performance.now(); pending++; maxPending = Math.max(maxPending, pending);
        try {
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', chunk.pcm))]
            .map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (chunk.meta.source === 'remote') await new Promise(resolve => setTimeout(resolve, 100));
          const ack = await captureTest.append(chunk);
          entries.push({ meta: chunk.meta, hash, ackMs: performance.now() - began, durable: ack.durable });
          return ack;
        } finally { pending--; }
      }
    } });
    try {
      await capture.start();
      const began = performance.now(), audioBegan = context.currentTime;
      await new Promise(resolve => setTimeout(resolve, durationMs));
      const wallMs = performance.now() - began, audioSeconds = context.currentTime - audioBegan;
      const cutoffs = await capture.stop();
      return { wallMs, audioSeconds, cutoffs, entries, maxPending, pending,
        context: context.state, state: capture.state,
        tracks: Object.values(streams).flatMap(stream => stream.getTracks().map(track => track.readyState)) };
    } finally { if (!['stopped', 'failed'].includes(capture.state)) await capture.abort('test cleanup').catch(() => {}); }
  }, durationMs);
  assert.equal(result.state, 'stopped'); assert.equal(result.context, 'closed');
  assert.deepEqual(result.tracks, ['ended', 'ended']); assert.equal(result.pending, 0);
  assert.ok(result.maxPending <= 16); assert.ok(result.wallMs >= durationMs - 10);
  const store = new ChunkStore(audio);
  await sealRecording({ store, sessionId: 'browser-test', cutoffs: result.cutoffs });
  const verified = await inspectRecording(audio); assert.equal(verified.state, 'complete');
  assert.equal(verified.index.chunks.length, result.entries.length);
  for (const source of ['microphone', 'remote']) {
    const entries = result.entries.filter(e => e.meta.source === source).sort((a, b) => a.meta.seq - b.meta.seq);
    let frame = 0;
    for (const [seq, entry] of entries.entries()) {
      assert.equal(entry.durable, true); assert.equal(entry.meta.seq, seq); assert.equal(entry.meta.startFrame, frame);
      const saved = verified.index.chunks.find(c => c.meta.source === source && c.meta.seq === seq);
      assert.ok(saved); assert.deepEqual(saved.meta, entry.meta);
      const { pcm } = await store.read(saved.file);
      assert.equal(createHash('sha256').update(pcm).digest('hex'), entry.hash);
      frame += entry.meta.frames;
    }
    assert.equal(frame, result.cutoffs[source]);
    assert.ok(Math.abs(frame / 48000 - result.audioSeconds) < .25, 'capture duration must follow the audio clock');
  }
  const delays = result.entries.map(e => e.ackMs).sort((a, b) => a - b);
  const report = { mode: 'wall-clock-synthetic-WebAudio', requestedMs: durationMs,
    wallMs: result.wallMs, audioSeconds: result.audioSeconds, cutoffs: result.cutoffs,
    chunks: result.entries.length, maxPending: result.maxPending, allEmittedHashesMatched: true,
    remoteInjectedAckDelayMs: 100, ackMs: { p50: delays[Math.floor(delays.length * .5)],
      p95: delays[Math.floor(delays.length * .95)], max: delays.at(-1) } };
  if (process.env.OMN_CAPTURE_SOAK_REPORT) await writeFile(process.env.OMN_CAPTURE_SOAK_REPORT, JSON.stringify(report, null, 2), { flag: 'wx' });
  t.diagnostic(JSON.stringify(report));
});
