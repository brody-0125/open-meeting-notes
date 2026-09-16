import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ChunkStore } from '../../src/store.mjs';
import { JobStore, runJob } from '../../src/jobs.mjs';
import { transcriptionJobs } from '../../src/transcription-jobs.mjs';
import { assembleTranscript, summaryInput } from '../../src/transcript.mjs';
import { validateSummary } from '../../src/contracts.mjs';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('saved native PCM → resample → actual STT → persisted transcript → actual summary; restart reuses results', { timeout: 240000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE, 'Prepare local model fixtures');
  const root = await mkdtemp(join(tmpdir(), 'omn-pipeline-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./main.mjs', import.meta.url))],
    env: { ...process.env, OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'harness-audio') } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const external = [];
  app.context().on('request', request => { if (!request.url().startsWith('omn://app/')) external.push(request.url()); });
  const input = await page.evaluate(async () => {
    const { InferenceClient } = await import('/inference-client.mjs');
    globalThis.pipelineClient = new InferenceClient();
    const context = new AudioContext({ sampleRate: 48000 });
    const buffer = await context.decodeAudioData(await (await fetch('/speech.wav')).arrayBuffer());
    const samples = Array.from(buffer.getChannelData(0));
    await context.close();
    return { samples, sampleRate: buffer.sampleRate };
  });
  assert.equal(input.sampleRate, 48000);
  const audio = new ChunkStore(join(root, 'audio'));
  for (let frame = 0, seq = 0; frame < input.samples.length; frame += 240000, seq++) {
    const frames = Math.min(240000, input.samples.length - frame);
    const bytes = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      const value = Math.max(-1, Math.min(1, input.samples[frame + i]));
      bytes.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
    }
    await audio.put({ version: 1, sessionId: 'pipeline', source: 'microphone', epoch: 0, seq, startFrame: frame, frames, sampleRate: 48000, channels: 1 }, bytes);
  }
  const sttPack = JSON.parse(await readFile(join(process.env.OMN_STT_FIXTURE, 'fixture-approval.json')));
  const summaryPack = JSON.parse(await readFile(join(process.env.OMN_SUMMARY_FIXTURE, 'fixture-approval.json')));
  const config = { sessionId: 'pipeline', source: 'microphone', revision: 1, modelHash: sttPack.manifestHash,
    settingsHash: sha({ engine: 'transformers-4.3.0', model: 'whisper-tiny', dtype: 'q8', language: 'en', preprocessing: 'web-audio-v1', maxTokens: 256 }) };
  let calls = 0;
  const execute = async (window, { key }) => {
    calls++;
    return page.evaluate(async ({ window, key }) => {
      const { prepareSttAudio } = await import('/resample.mjs');
      window.samples = new Float32Array(window.samples);
      const audio = await prepareSttAudio(window, key);
      return globalThis.pipelineClient.run('transcribe', { modelId: 'whisper-tiny', language: 'en', audio });
    }, { window: { ...window, samples: Array.from(window.samples) }, key });
  };
  const index = await audio.index();
  const jobRoot = join(root, 'jobs');
  const completed = await Array.fromAsync(transcriptionJobs(audio, index, new JobStore(jobRoot), config, execute));
  const firstCalls = calls;
  assert.ok(firstCalls > 0);
  const resumed = await Array.fromAsync(transcriptionJobs(audio, index, new JobStore(jobRoot), config, execute));
  assert.equal(calls, firstCalls);
  assert.deepEqual(resumed, completed);
  const transcript = assembleTranscript(resumed, 1);
  const summaryTranscript = summaryInput(transcript);
  assert.match(summaryTranscript.segments.map(s => s.rawText).join(' '), /report/i);
  const descriptor = { version: 1, sessionId: 'pipeline', kind: 'summarize', revision: 1,
    inputHash: sha(summaryTranscript), modelHash: summaryPack.manifestHash, settingsHash: sha({ engine: 'webllm-0.2.85', prompt: 'classification-v2', maxTokens: 1024, temperature: 0 }) };
  let summaryCalls = 0;
  const summarize = async () => { summaryCalls++; return page.evaluate(transcript => globalThis.pipelineClient.run('summarize', { transcript }), summaryTranscript); };
  const validate = value => validateSummary(value, summaryTranscript.segments.map(s => ({ id: s.id, text: s.rawText })), 1);
  const summary = await runJob(new JobStore(jobRoot), descriptor, summarize, validate);
  assert.deepEqual(await runJob(new JobStore(jobRoot), descriptor, summarize, validate), summary);
  assert.equal(summaryCalls, 1);
  assert.ok(summary.items.some(i => i.kind === 'action' && i.evidence.some(e => /report/i.test(e.quote))));
  assert.deepEqual(external, []);
  await page.evaluate(() => globalThis.pipelineClient.dispose());
  t.diagnostic(JSON.stringify({ jobs: completed.length, transcript: summaryTranscript, summary }));
});
