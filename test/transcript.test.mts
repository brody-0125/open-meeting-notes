import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTranscript, summaryInput } from '../src/transcript.mjs';
function job(key, offset, text, start, end, source = 'microphone') {
  return { key, origin: { sessionId: 'meeting', source, epoch: 0, sampleRate: 16000, startFrame: offset * 16000, frames: 30 * 16000 },
    segments: [{ id: `${key}:0`, jobId: key, source, start, end, rawText: text, flags: [] }] };
}

test('verified pauses are visible interruptions, while only exactly covered gaps permit summary', () => {
  const jobs = [job('a', 0, '첫 발언', 1, 2), job('b', 35, '다음 발언', 36, 37)];
  const options = { pauses: [{ pauseId: 1, cutoffs: { microphone: 30 * 16000, remote: 0 },
    starts: { microphone: 35 * 16000, remote: 5 * 16000 } }], formats: { microphone: { sampleRate: 16000 }, remote: null } };
  const transcript = assembleTranscript(jobs, 1, options);
  assert.deepEqual(transcript.gaps, []);
  assert.deepEqual(transcript.pauses, [{ pauseId: 1, source: 'microphone', start: 30, end: 35 }]);
  assert.equal(summaryInput(transcript).segments.length, 2);
  const partial = structuredClone(options); partial.pauses[0].starts.microphone = 34 * 16000;
  assert.equal(assembleTranscript(jobs, 1, partial).gaps.length, 1);
  assert.throws(() => summaryInput(assembleTranscript(jobs, 1, partial)), /review/);
  assert.throws(() => assembleTranscript([job('c', 29, '정지 중 발언', 31, 32)], 1, options), /pause/);
});

test('consecutive pause ranges cover a gap and open final pause remains explicit', () => {
  const options = { formats: { microphone: { sampleRate: 16000 }, remote: null }, pauses: [
    { pauseId: 1, cutoffs: { microphone: 480000, remote: 0 }, starts: { microphone: 512000, remote: 32000 } },
    { pauseId: 2, cutoffs: { microphone: 512000, remote: 32000 }, starts: { microphone: 560000, remote: 80000 } },
    { pauseId: 3, cutoffs: { microphone: 1040000, remote: 80000 }, starts: null }
  ] };
  const result = assembleTranscript([job('a', 0, '전', 1, 2), job('b', 35, '후', 36, 37)], 1, options);
  assert.equal(result.gaps.length, 0);
  assert.deepEqual(result.pauses.at(-1), { pauseId: 3, source: 'microphone', start: 65, end: null });
});

test('unconfirmed speech cannot become summary evidence even without overlaps or gaps', () => {
  const input = job('a', 0, '수고하셨습니다.', 0, 1);
  input.segments[0].flags = ['speech-unconfirmed'];
  const transcript = assembleTranscript([input], 1);
  assert.throws(() => summaryInput(transcript), /review/);
  assert.equal(transcript.segments[0].rawText, '수고하셨습니다.');
});
test('C06 identical overlap merges view only and retains both evidence IDs', () => {
  const a = job('a', 0, '보고서를 작성합니다.', 28, 29), b = job('b', 28, '보고서를 작성합니다.', 28, 29);
  const transcript = assembleTranscript([b, a], 1);
  assert.equal(transcript.segments.length, 1);
  assert.deepEqual(transcript.segments[0].evidenceIds, ['a:0', 'b:0']);
  assert.equal(a.segments.length, 1); assert.equal(b.segments.length, 1);
  assert.deepEqual(summaryInput(transcript), { revision: 1, segments: [{ id: 'a:0', rawText: '보고서를 작성합니다.' }] });
});
test('same words at different timestamps or sources are not silently deleted', () => {
  const transcript = assembleTranscript([job('a', 0, '네', 27, 28), job('b', 28, '네', 29, 30), job('c', 0, '네', 27, 28, 'remote')], 1);
  assert.equal(transcript.segments.length, 3);
  assert.equal(transcript.conflicts.length, 0);
});
test('C08 conflicting overlap blocks automatic summary and preserves both originals', () => {
  const transcript = assembleTranscript([job('a', 0, '금요일까지 합니다.', 28, 29), job('b', 28, '금요일까지 안 합니다.', 28, 29)], 2);
  assert.equal(transcript.segments.length, 2);
  assert.equal(transcript.conflicts.length, 1);
  assert.throws(() => summaryInput(transcript), /review/);
});
test('order of completed jobs cannot change transcript identity or evidence', () => {
  const jobs = [job('a', 0, '첫 발언', 1, 2), job('b', 28, '다음 발언', 29, 30), job('c', 56, '마지막 발언', 57, 58)];
  assert.deepEqual(assembleTranscript(jobs, 3), assembleTranscript([...jobs].reverse(), 3));
});
test('gaps, mixed sessions and duplicate job IDs cannot masquerade as complete transcript', () => {
  const a = job('a', 0, '첫 발언', 1, 2), b = job('b', 35, '다음 발언', 36, 37);
  const transcript = assembleTranscript([a, b], 1);
  assert.equal(transcript.gaps.length, 1);
  assert.throws(() => summaryInput(transcript), /review/);
  assert.throws(() => assembleTranscript([a, a], 1), /duplicate/);
  b.origin.sessionId = 'other';
  assert.throws(() => assembleTranscript([a, b], 1), /session/);
});
