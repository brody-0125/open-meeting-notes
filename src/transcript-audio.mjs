import { pcmWindows } from './audio/windows.mjs';

// Reuse the verified, bounded reader. Late excerpts scan preceding chunks;
// add a verified seek index only if measured review latency requires it.
export async function transcriptAudio(store, index, sessionId, segment, { signal, pauses = [] } = {}) {
  const { source, epoch, start, end } = segment;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(sessionId) ||
      !['microphone', 'remote'].includes(source) || !Number.isSafeInteger(epoch) || epoch < 0 ||
      !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 30)
    throw new Error('invalid transcript audio range');
  signal?.throwIfAborted();
  for await (const window of pcmWindows(store, index, { sessionId, source, epoch, signal, pauses })) {
    const startFrame = Math.floor(start * window.sampleRate + 1e-7);
    const endFrame = Math.ceil(end * window.sampleRate - 1e-7);
    if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) throw new Error('invalid transcript audio range');
    if (startFrame < window.startFrame || endFrame > window.startFrame + window.samples.length) continue;
    signal?.throwIfAborted();
    return { source, epoch, sampleRate: window.sampleRate, startFrame,
      samples: window.samples.slice(startFrame - window.startFrame, endFrame - window.startFrame) };
  }
  throw new Error('transcript audio range unavailable');
}
