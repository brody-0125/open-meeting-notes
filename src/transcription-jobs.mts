import { createHash } from 'node:crypto';
import { pcmWindows } from './audio/windows.mjs';
import { jobKey, runJob } from './jobs.mjs';

// execute(window, {key, signal}) is the renderer/Worker bridge: resample the
// native-rate window with prepareSttAudio(window, key), then run transcription.
// This yields raw per-window results; overlap reconciliation remains separate.
export async function* transcriptionJobs(audioStore, index, jobs, config, execute, { signal } = {}) {
  const { revision, modelHash, settingsHash, ...windowOptions } = config;
  for await (const window of pcmWindows(audioStore, index, { ...windowOptions, signal })) {
    const { samples, ...windowOrigin } = window;
    const origin = { ...windowOrigin, frames: samples.length };
    const inputHash = createHash('sha256').update(JSON.stringify(origin)).update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).digest('hex');
    const descriptor = { version: 1, sessionId: window.sessionId, kind: 'transcribe', revision, inputHash, modelHash, settingsHash };
    const key = jobKey(descriptor);
    const start = window.startFrame / window.sampleRate;
    const end = (window.startFrame + samples.length) / window.sampleRate;
    const validate = segments => {
      if (!Array.isArray(segments) || segments.length > 1024) throw new Error('invalid transcript result');
      const ids = new Set();
      for (const segment of segments) {
        if (segment.jobId !== key || segment.id !== `${key}:${ids.size}` || ids.has(segment.id) || segment.source !== window.source ||
          !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < start || segment.end > end || segment.end < segment.start ||
          typeof segment.rawText !== 'string' || segment.rawText.length > 16000 || !Array.isArray(segment.flags) ||
          segment.flags.some(flag => !['estimated-end', 'clipped-end', 'speech-unconfirmed'].includes(flag))) throw new Error('invalid transcript result');
        ids.add(segment.id);
      }
    };
    const segments = await runJob(jobs, descriptor, context => execute(window, context), validate, { signal });
    yield { key, origin, segments };
  }
}
