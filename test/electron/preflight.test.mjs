import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const ending of ['start', 'cancel', 'context-loss']) test(`input preflight stores no audio: ${ending}`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-preflight-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: root, OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const result = await page.evaluate(async ending => {
    const { prepareCapture } = await import('/capture-device.mjs');
    const context = new AudioContext({ sampleRate: 48000 }), streams = {}, gains = {}, chunks = [];
    for (const source of ['microphone', 'remote']) {
      const tone = new OscillatorNode(context), out = context.createMediaStreamDestination();
      const gain = gains[source] = new GainNode(context, { gain: .5 });
      tone.connect(gain).connect(out); tone.start(); streams[source] = out.stream;
    }
    const capture = await prepareCapture({ context, streams, sessionId: 'preflight', sink: {
      append: async chunk => { chunks.push(chunk); return { durable: true }; },
      stop: async () => {}, finish: async () => {}, abort: async () => {}
    } });
    try {
      await capture.preflight();
      await new Promise(resolve => setTimeout(resolve, 200));
      const before = { chunks: chunks.length, levels: capture.levels(), state: capture.state };
      if (ending === 'start') {
        // Silence before recording starts: test tone must never enter stored PCM.
        for (const gain of Object.values(gains)) gain.gain.value = 0;
        await new Promise(resolve => setTimeout(resolve, 200));
        await capture.start();
        await new Promise(resolve => setTimeout(resolve, 200));
        await capture.stop();
      } else if (ending === 'cancel') await capture.abort('preflight cancelled').catch(() => {});
      else { await context.suspend(); await capture.done.catch(() => {}); }
      return { before, count: chunks.length, first: chunks.map(c => c.meta),
        nonzero: chunks.some(c => new Int16Array(c.pcm).some(value => value !== 0)),
        levels: capture.levels(), state: capture.state, context: context.state,
        tracks: Object.values(streams).flatMap(s => s.getTracks().map(t => t.readyState)) };
    } finally { if (!['stopped', 'failed'].includes(capture.state)) await capture.abort('test cleanup').catch(() => {}); }
  }, ending);
  assert.equal(result.before.chunks, 0); assert.equal(result.before.state, 'idle');
  for (const source of ['microphone', 'remote']) assert.ok(result.before.levels[source] > .3);
  assert.equal(result.nonzero, false); assert.equal(result.levels, null);
  assert.equal(result.context, 'closed'); assert.deepEqual(result.tracks, ['ended', 'ended']);
  if (ending === 'start') {
    assert.equal(result.state, 'stopped'); assert.equal(result.count, 2);
    for (const meta of result.first) { assert.equal(meta.startFrame, 0); assert.equal(meta.seq, 0); }
  } else { assert.equal(result.state, 'failed'); assert.equal(result.count, 0); }
});
