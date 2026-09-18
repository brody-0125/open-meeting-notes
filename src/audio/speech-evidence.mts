// Frame ranges are relative to the measured 16kHz clip; transcript times use
// the original recording clock. Overlap is evidence of detection, not accuracy.
export function markUnconfirmedSpeech(segments, audio, measurement) {
  const ranges = measurement?.speechRanges ?? [];
  if (measurement != null) {
    if (!Array.isArray(measurement.speechRanges)) throw new Error('invalid speech measurement');
    let end = 0;
    for (const range of ranges) {
      if (!Number.isSafeInteger(range?.startFrame) || !Number.isSafeInteger(range.endFrame) ||
        range.startFrame < end || range.endFrame <= range.startFrame || range.endFrame > audio.samples.length)
        throw new Error('invalid speech measurement');
      end = range.endFrame;
    }
  }
  const offset = audio.origin ? audio.origin.startFrame / audio.origin.sampleRate : audio.startFrame / audio.sampleRate;
  return segments.map(segment => {
    const confirmed = segment.source === audio.source && ranges.some(range =>
      Math.max(segment.start, offset + range.startFrame / audio.sampleRate) <
      Math.min(segment.end, offset + range.endFrame / audio.sampleRate));
    return confirmed ? segment : { ...segment, flags: [...new Set([...segment.flags, 'speech-unconfirmed'])] };
  });
}
