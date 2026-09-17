// Normalize Apple helper chunks into transcription-jobs segment shape.
export function appleChunksToSegments(chunks, audio, jobId) {
  const { source, startFrame, sampleRate, samples, origin } = audio;
  if (jobId !== audio.jobId) throw new Error('invalid job');
  if (sampleRate !== 16000 || !(samples instanceof Float32Array) || samples.length < 1) throw new Error('invalid 16kHz audio');
  if (!Array.isArray(chunks) || chunks.length > 1024) throw new Error('invalid transcript');
  if (samples.every(sample => sample === 0)) return [];
  const duration = origin ? origin.frames / origin.sampleRate : samples.length / sampleRate;
  const offset = origin ? origin.startFrame / origin.sampleRate : startFrame / sampleRate;
  return chunks.map((chunk, i) => {
    if (typeof chunk.text !== 'string' || chunk.text.length > 16000) throw new Error('invalid segment');
    const start = chunk.start, end = chunk.end;
    if (!Number.isFinite(start) || start < 0 || start > duration ||
      !Number.isFinite(end) || end < start) throw new Error('invalid timestamp');
    const flags = end > duration ? ['clipped-end'] : [];
    return { id: `${jobId}:${i}`, jobId, source, start: offset + start,
      end: offset + Math.min(end, duration), rawText: chunk.text, flags };
  });
}
