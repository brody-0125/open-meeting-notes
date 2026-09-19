export async function transcribeChunk(run, input, { signal, language = 'ko' } = {}) {
  const { jobId, source, startFrame, sampleRate, samples } = input;
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(jobId) || !['microphone', 'remote'].includes(source)) throw new Error('invalid job');
  if (sampleRate !== 16000 || !Number.isSafeInteger(startFrame) || startFrame < 0 ||
    !(samples instanceof Float32Array) || samples.length < 1 || samples.length > 480000 ||
    !samples.every(Number.isFinite)) throw new Error('invalid 16kHz audio');
  const { origin } = input;
  if (origin && (!Number.isSafeInteger(origin.startFrame) || origin.startFrame < 0 ||
    ![16000, 44100, 48000].includes(origin.sampleRate) || !Number.isSafeInteger(origin.frames) || origin.frames < 1 ||
    origin.frames > origin.sampleRate * 30 || Math.round(origin.frames * 16000 / origin.sampleRate) !== samples.length ||
    Math.round(origin.startFrame * 16000 / origin.sampleRate) !== startFrame)) throw new Error('invalid source origin');
  signal?.throwIfAborted();
  // Exact digital silence cannot contain speech. Do not apply an amplitude
  // threshold: quiet nonzero input still belongs to the recognizer.
  if (samples.every(sample => sample === 0)) return [];
  const result = await run(samples, { language, task: 'transcribe', return_timestamps: true, max_new_tokens: 256 });
  signal?.throwIfAborted();
  const duration = origin ? origin.frames / origin.sampleRate : samples.length / sampleRate;
  const offset = origin ? origin.startFrame / origin.sampleRate : startFrame / sampleRate;
  const chunks = result.chunks ?? (result.text?.trim() ? [{ text: result.text, timestamp: [0, null] }] : []);
  if (!Array.isArray(chunks) || chunks.length > 1024) throw new Error('invalid transcript');
  const segments = [];
  for (const [i, chunk] of chunks.entries()) {
    if (typeof chunk.text !== 'string' || chunk.text.length > 16000 || !Array.isArray(chunk.timestamp) || chunk.timestamp.length !== 2) throw new Error('invalid segment');
    if (loopingTranscript(chunk.text)) continue;
    const [start, end] = chunk.timestamp;
    if (!Number.isFinite(start) || start < 0 || start > duration ||
      (end !== null && (!Number.isFinite(end) || end < start))) throw new Error('invalid timestamp');
    const flags = end === null ? ['estimated-end'] : end > duration ? ['clipped-end'] : [];
    segments.push({ id: `${jobId}:${i}`, jobId, source, start: offset + start,
      end: offset + Math.min(end ?? duration, duration), rawText: chunk.text, flags });
  }
  return segments;
}

function loopingTranscript(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.length >= 12 && new Set(tokens).size <= 2;
}
