import { validatePauses } from './pauses.mjs';

// A conservative view over immutable per-job transcripts, not a text rewriting
// algorithm. Uncertain overlaps remain visible for review.
export function assembleTranscript(jobs, revision, { pauses = [], formats = {} } = {}) {
  // These records must originate from a verified recording, not model output.
  pauses = structuredClone(pauses); validatePauses(pauses);
  if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(jobs)) throw new Error('invalid transcript revision');
  const result = { revision, sessionId: jobs[0]?.origin.sessionId ?? null, segments: [], conflicts: [], gaps: [] };
  if (pauses.length) result.pauses = pauses.flatMap(pause => ['microphone', 'remote'].flatMap(source => {
    const rate = formats[source]?.sampleRate;
    if (rate == null) return []; // No stored PCM means no established source clock.
    if (![16000, 44100, 48000].includes(rate)) throw new Error('invalid pause sample rate');
    return [{ pauseId: pause.pauseId, source, start: pause.cutoffs[source] / rate, end: pause.starts === null ? null : pause.starts[source] / rate }];
  }));
  const keys = new Set(), records = [], coverage = new Map();
  const ordered = [...jobs].sort((a, b) => a.origin.startFrame / a.origin.sampleRate - b.origin.startFrame / b.origin.sampleRate || a.key.localeCompare(b.key));
  for (const job of ordered) {
    const { origin, key, segments } = job;
    if (keys.has(key)) throw new Error('duplicate job');
    keys.add(key);
    if (origin.sessionId !== result.sessionId) throw new Error('mixed session transcripts');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(key) || !['microphone', 'remote'].includes(origin.source) ||
      !Number.isSafeInteger(origin.epoch) || origin.epoch < 0 || ![16000, 44100, 48000].includes(origin.sampleRate) ||
      !Number.isSafeInteger(origin.startFrame) || origin.startFrame < 0 || !Number.isSafeInteger(origin.frames) ||
      origin.frames < 1 || origin.frames > origin.sampleRate * 30 || !Array.isArray(segments)) throw new Error('invalid job origin');
    const start = origin.startFrame / origin.sampleRate, end = (origin.startFrame + origin.frames) / origin.sampleRate;
    if (pauses.length && (origin.epoch !== 0 || formats[origin.source]?.sampleRate !== origin.sampleRate)) throw new Error('pause clock mismatch');
    if (pauses.some(pause => origin.startFrame + origin.frames > pause.cutoffs[origin.source] &&
      (pause.starts === null || origin.startFrame < pause.starts[origin.source]))) throw new Error('transcript job crosses pause');
    const group = `${origin.source}:${origin.epoch}`;
    const covered = coverage.get(group);
    if (covered && covered.sampleRate !== origin.sampleRate) throw new Error('format changed within epoch');
    if (covered && start > covered.end) {
      let boundary = covered.endFrame;
      for (const pause of pauses) if (pause.starts !== null && pause.cutoffs[origin.source] === boundary)
        boundary = pause.starts[origin.source];
      if (boundary !== origin.startFrame) result.gaps.push({ source: origin.source, epoch: origin.epoch, start: covered.end, end: start });
    }
    coverage.set(group, { sampleRate: origin.sampleRate, end: Math.max(covered?.end ?? 0, end),
      endFrame: Math.max(covered?.endFrame ?? 0, origin.startFrame + origin.frames) });
    for (const [i, segment] of segments.entries()) {
      if (segment.id !== `${key}:${i}` || segment.jobId !== key || segment.source !== origin.source ||
        !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < start - 1e-9 || segment.end > end + 1e-9 ||
        segment.end < segment.start || typeof segment.rawText !== 'string' || !Array.isArray(segment.flags)) throw new Error('invalid transcript segment');
      records.push({ ...structuredClone(segment), epoch: origin.epoch, evidenceIds: [segment.id], jobIds: [key] });
    }
  }
  records.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  let active = [];
  for (const segment of records) {
    active = active.filter(previous => previous.end >= segment.start);
    const peers = active.filter(previous => previous.source === segment.source && previous.epoch === segment.epoch);
    const duplicate = peers.find(previous => !previous.jobIds.includes(segment.jobId) && previous.start === segment.start &&
      previous.end === segment.end && previous.rawText === segment.rawText);
    if (duplicate) {
      duplicate.evidenceIds.push(segment.id); duplicate.jobIds.push(segment.jobId);
      duplicate.flags = [...new Set([...duplicate.flags, ...segment.flags])];
      continue;
    }
    for (const previous of peers) {
      if (previous.jobIds.includes(segment.jobId) || Math.min(previous.end, segment.end) <= Math.max(previous.start, segment.start)) continue;
      result.conflicts.push({ left: previous.id, right: segment.id, reason: 'overlap-review' });
    }
    active.push(segment); result.segments.push(segment);
  }
  return result;
}

export function summaryInput(transcript) {
  if (transcript.conflicts.length || transcript.gaps.length || hasUnconfirmedSpeech(transcript)) throw new Error('transcript requires review before automatic summary');
  return { revision: transcript.revision, segments: transcript.segments.filter(segment => !speechExcluded(segment)).map(({ id, rawText }) => ({ id, rawText })) };
}

export function hasUnconfirmedSpeech(transcript) {
  return transcript.segments.some(segment => segment.flags?.includes('speech-unconfirmed') && !['accepted', 'rejected'].includes(segment.speechReview));
}

export function speechExcluded(segment) {
  return segment.flags?.includes('speech-unconfirmed') && segment.speechReview === 'rejected';
}
