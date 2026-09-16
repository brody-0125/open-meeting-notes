import { _electron as electron } from 'playwright';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { characterErrors } from '../src/stt-quality.mjs';
import { markUnconfirmedSpeech } from '../src/audio/speech-evidence.mjs';

const [speechDirectory, reportPath, modelId = 'whisper-tiny', device = 'wasm'] = process.argv.slice(2);
if (!['whisper-tiny', 'whisper-small'].includes(modelId)) throw new Error('unsupported evaluation model');
if (!['wasm', 'webgpu'].includes(device)) throw new Error('unsupported evaluation device');
if (!speechDirectory || !reportPath || !process.env.OMN_STT_FIXTURE || !process.env.OMN_VAD_FIXTURE) throw new Error('speech directory, report path and local STT/VAD fixtures required');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const corpusBytes = await readFile(new URL('../test/fixtures/korean-stt.json', import.meta.url));
const corpus = JSON.parse(corpusBytes), root = await mkdtemp(join(tmpdir(), 'omn-vad-korean-'));
const models = {};
for (const [kind, variable] of [['stt', 'OMN_STT_FIXTURE'], ['vad', 'OMN_VAD_FIXTURE']]) models[kind] =
  JSON.parse(await readFile(join(process.env[variable], 'fixture-approval.json'), 'utf8')).manifestHash;
let app;
try {
  app = await electron.launch({ args: [fileURLToPath(new URL('../test/electron/main.mjs', import.meta.url))], env: { ...process.env,
    OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio'), OMN_SUMMARY_FIXTURE: '' } });
  const page = await app.firstWindow();
  const runtime = await page.evaluate(async ({ modelId, device }) => {
    const { loadWhisper } = await import('/whisper.mjs'), { loadSilero } = await import('/silero.mjs');
    const adapter = device === 'webgpu' ? await navigator.gpu?.requestAdapter() : null;
    if (device === 'webgpu' && !adapter) throw new Error('WebGPU adapter unavailable');
    const started = performance.now();
    globalThis.stt = await loadWhisper({ modelId, device }); globalThis.vad = await loadSilero();
    return { loadMs: performance.now() - started, userAgent: navigator.userAgent,
      adapter: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description } : null };
  }, { modelId, device });
  const cases = [];
  for (const item of corpus) {
    const wav = await readFile(join(resolve(speechDirectory), `${item.id}.wav`));
    for (const variant of ['original', 'quiet', 'quiet-with-noise']) {
      const result = await page.evaluate(async ({ bytes, variant, id }) => {
        const context = new AudioContext({ sampleRate: 16000 });
        const decoded = await context.decodeAudioData(new Uint8Array(bytes).buffer);
        const samples = decoded.getChannelData(0).slice(); await context.close();
        let seed = 123456789;
        for (let i = 0; i < samples.length; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          samples[i] = samples[i] * (variant === 'original' ? 1 : .02) +
            (variant === 'quiet-with-noise' ? .0003 * (2 * seed / 4294967296 - 1) : 0);
        }
        const pcmHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', samples.buffer))].map(x => x.toString(16).padStart(2, '0')).join('');
        const { measureSpeech } = await import('/silero.mjs');
        const measurement = await measureSpeech(vad, { source: 'microphone', sampleRate: 16000, samples });
        // Always transcribe: this measures what gating would lose, not a filtered score.
        const started = performance.now();
        const segments = await stt.transcribe({ jobId: id, source: 'microphone', startFrame: 0, sampleRate: 16000, samples }, { language: 'ko' });
        return { seconds: samples.length / 16000, inferenceMs: performance.now() - started,
          sampleCount: samples.length, segments, ...measurement, pcmHash,
          hypothesis: segments.map(s => s.rawText).join(' ') };
      }, { bytes: [...wav], variant, id: item.id });
      const reviewed = markUnconfirmedSpeech(result.segments, { source: 'microphone', sampleRate: 16000,
        startFrame: 0, samples: { length: result.sampleCount } }, result);
      const unconfirmedSegments = reviewed.filter(s => s.flags.includes('speech-unconfirmed')).map(s => s.id);
      cases.push({ id: item.id, variant, reference: item.text, wavSha256: sha(wav), ...result,
        unconfirmedSegments, ...characterErrors(item.text, result.hypothesis) });
      console.log(JSON.stringify({ id: item.id, variant, speechFrames: result.speechFrames, unconfirmedSegments }));
    }
  }
  const missed = cases.filter(c => c.speechFrames === 0).map(c => ({ id: c.id, variant: c.variant }));
  const metrics = ['original', 'quiet', 'quiet-with-noise'].map(variant => {
    const selected = cases.filter(c => c.variant === variant);
    return { variant, cases: selected.length,
      segments: selected.reduce((n, c) => n + c.segments.length, 0),
      unconfirmedSegments: selected.reduce((n, c) => n + c.unconfirmedSegments.length, 0),
      casesRequiringReview: selected.filter(c => c.unconfirmedSegments.length).length,
      microCer: selected.reduce((n, c) => n + c.edits, 0) / selected.reduce((n, c) => n + c.referenceCharacters, 0) };
  });
  await writeFile(resolve(reportPath), JSON.stringify({ version: 2, modelId, dtype: 'q8', device, runtime, corpusHash: sha(corpusBytes), models,
    limits: 'Single synthetic Korean voice; 18 short clips, no release-quality claim; segment review diagnostic, no text filtered from CER.',
    missed, metrics, cases }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ missed, metrics, reportPath: resolve(reportPath) }));
  if (missed.length) process.exitCode = 1;
  await page.evaluate(async () => { await stt.dispose(); await vad.dispose(); });
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
