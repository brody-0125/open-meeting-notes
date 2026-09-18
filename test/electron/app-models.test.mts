import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('product app verified local routes run real STT and summary in Worker', { timeout: 180000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-app-models-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const wav = await readFile(join(process.env.OMN_STT_FIXTURE, 'speech.wav'));
  const result = await page.evaluate(async bytes => {
    const models = await window.meeting.models();
    if (models.error || !models.stt || !models.summary) throw new Error(JSON.stringify(models));
    const legacyDenied = (await fetch('/models/qwen/resolve/main/mlc-chat-config.json')).status === 403;
    const unknownDenied = (await fetch(`/packs/${'0'.repeat(64)}/models/qwen/resolve/main/mlc-chat-config.json`)).status === 403;
    const attempts = [];
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url ?? String(args[0]), location.href);
      if (url.protocol !== 'omn:' || url.host !== 'app') { attempts.push(url.href); throw new Error('external fetch denied'); }
      return fetchOriginal(...args);
    };
    const { InferenceClient } = await import('/inference-client.mjs');
    const context = new AudioContext({ sampleRate: 16000 });
    const buffer = await context.decodeAudioData(new Uint8Array(bytes).buffer);
    const samples = buffer.getChannelData(0).slice();
    await context.close();
    const client = new InferenceClient();
    try {
      const segments = await client.run('transcribe', { modelId: models.stt.modelId, modelHash: models.stt.modelHash, language: 'en', audio: {
        jobId: 'app-local-model', source: 'microphone', startFrame: 0, sampleRate: 16000, samples
      } });
      const summary = await client.run('summarize', { modelHash: models.summary.modelHash, transcript: { revision: 1, segments: segments.map(s => ({ id: s.id, rawText: s.rawText })) } });
      const long = { revision: 1, segments: [{ id: 'long', rawText: '자료 검토는 아직 끝나지 않았습니다. '.repeat(450) }] };
      const partitions = await client.run('plan-summary', { modelHash: models.summary.modelHash, transcript: long });
      const firstPartSummary = await client.run('summarize', { modelHash: models.summary.modelHash, transcript: partitions[0] });
      // Same Worker/model, real tokenizer, then preflight rejection before generation.
      let oversizedError;
      try { await client.run('summarize', { modelHash: models.summary.modelHash, transcript: long }); }
      catch (error) { oversizedError = error.message; }
      return { segments, summary, attempts, legacyDenied, unknownDenied, partitions,
        originalText: long.segments[0].rawText, oversizedError, firstPartSummary };
    } finally { client.dispose(); }
  }, [...wav]);
  assert.match(result.segments.map(s => s.rawText).join(' ').toLowerCase(), /report/);
  assert.ok(result.summary.items.length > 0);
  assert.deepEqual(result.attempts, []);
  assert.equal(result.legacyDenied, true);
  assert.equal(result.unknownDenied, true);
  assert.ok(result.partitions.length > 1);
  assert.equal(result.partitions.flatMap(p => p.segments).map(s => s.rawText).join(''), result.originalText);
  assert.ok(result.partitions.every(p => p.segments.every(s => s.id === 'long')));
  assert.match(result.oversizedError, /context budget/);
  assert.equal(result.firstPartSummary.revision, 1);
  assert.ok(result.firstPartSummary.items.every(item => item.evidence.every(e => e.segmentId === 'long')));
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
  t.diagnostic(JSON.stringify(result.summary));
  t.diagnostic(JSON.stringify({ partitions: result.partitions.length, firstPartCharacters: result.partitions[0].segments[0].rawText.length,
    firstPartSummary: result.firstPartSummary, oversizedError: result.oversizedError }));
});
