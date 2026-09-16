import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('real worker abort, restart, local transcription → model switch → summary', { timeout: 240000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE, 'Prepare both local model fixtures');
  const root = await mkdtemp(join(tmpdir(), 'omn-worker-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const external = [];
  app.context().on('request', request => { if (!request.url().startsWith('omn://app/')) external.push(request.url()); });
  const page = await app.firstWindow();
  let workersCreated = 0;
  page.on('worker', () => workersCreated++);
  const result = await page.evaluate(async () => {
    const { InferenceClient } = await import('/inference-client.mjs');
    const bytes = await (await fetch('/speech.wav')).arrayBuffer();
    const context = new AudioContext({ sampleRate: 16000 });
    const audio = await context.decodeAudioData(bytes);
    const samples = audio.getChannelData(0).slice();
    await context.close();
    const client = new InferenceClient();
    const request = { modelId: 'whisper-tiny', language: 'en', audio: { jobId: 'worker-test', source: 'microphone', sampleRate: 16000, startFrame: 0, samples } };
    try {
      const controller = new AbortController();
      const cancelled = client.run('transcribe', request, { signal: controller.signal }).then(() => false, error => error.name === 'AbortError');
      await new Promise(resolve => setTimeout(resolve, 50));
      controller.abort();
      const aborted = await cancelled;
      const segments = await client.run('transcribe', request);
      const summary = await client.run('summarize', { transcript: { revision: 1, segments } });
      return { aborted, segments, summary };
    } finally { client.dispose(); }
  });
  assert.equal(result.aborted, true);
  assert.equal(workersCreated, 2);
  assert.deepEqual(external, []);
  assert.match(result.segments.map(s => s.rawText).join(' '), /report/i);
  assert.ok(result.summary.items.some(i => i.kind === 'action' && i.evidence.some(e => /report/i.test(e.quote))));
  t.diagnostic(JSON.stringify(result.summary));
});
