import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChunkStore } from '../src/store.mjs';
import { sealRecording } from '../src/recording-seal.mjs';
import { analyzeRecording } from '../src/analyze-recording.mjs';
import { CorrectionStore } from '../src/corrections.mjs';
import { ReviewStore, speechReviewKey } from '../src/reviews.mjs';
import { PauseStore } from '../src/pauses.mjs';
import { meetingMarkdown } from '../src/export.mjs';
const models = { stt: { backend: 'transformers', modelId: 'tiny', modelHash: 'a'.repeat(64), device: 'wasm' },
  summary: { modelHash: 'b'.repeat(64) } };
const candidate = input => ({ version: 1, revision: 1, items: [{ kind: 'topic', status: 'candidate', text: input.segments[0].rawText,
  evidence: [{ segmentId: input.segments[0].id, quote: input.segments[0].rawText }] }] });

test('transcribe-only skips summary inference', async t => {
  const root = await fixture(t), calls = [];
  const execute = async (operation, input) => {
    calls.push(operation);
    if (operation === 'plan-summary') return [input.transcript];
    if (operation !== 'transcribe') return candidate(input.transcript);
    return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01, rawText: 'hello', flags: [] }];
  };
  const result = await analyzeRecording({ root, models, execute, mode: 'transcribe' });
  assert.equal(result.summary, null); assert.equal(result.needsReview, false);
  assert.ok(calls.every(op => op === 'transcribe'));
  const summaryOnly = await analyzeRecording({ root, models, execute: (operation, input) => {
    if (operation === 'transcribe') assert.fail('must use cached transcript');
    if (operation === 'plan-summary') return [input.transcript];
    return candidate(input.transcript);
  }, mode: 'summarize' });
  assert.ok(summaryOnly.summary);
});

test('unconfirmed speech is preserved but cannot enter summary; VAD identity invalidates cached STT', async t => {
  const root = await fixture(t), calls = [];
  const execute = async (operation, input) => {
    calls.push(operation); assert.equal(operation, 'transcribe');
    return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01,
      rawText: '수고하셨습니다.', flags: ['speech-unconfirmed'] }];
  };
  const configured = { ...models, vad: { modelHash: 'c'.repeat(64) } };
  const first = await analyzeRecording({ root, models: configured, execute });
  assert.equal(first.summary, null); assert.equal(first.needsReview, true);
  assert.equal(first.transcript.segments[0].rawText, '수고하셨습니다.');
  assert.deepEqual(await analyzeRecording({ root, models: configured, execute }), first);
  assert.equal(calls.length, 1);
  await analyzeRecording({ root, models: { ...configured, vad: { modelHash: 'd'.repeat(64) } }, execute });
  assert.equal(calls.length, 2);
});
async function fixture(t, sealed = true) {
  const root = await mkdtemp(join(tmpdir(), 'omn-analyze-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChunkStore(root);
  await store.put({ version: 1, sessionId: 'analysis', epoch: 0, source: 'microphone', seq: 0, startFrame: 0,
    sampleRate: 16000, channels: 1, frames: 160 }, Buffer.alloc(320));
  if (sealed) await sealRecording({ store, sessionId: 'analysis', cutoffs: { microphone: 160, remote: 0 } });
  return root;
}

test('sealed paused recording transcribes separate spans at original offsets and reuses both jobs', async t => {
  const root = await fixture(t, false), store = new ChunkStore(root), pauses = new PauseStore(root, 'analysis');
  await pauses.pause({ pauseId: 1, cutoffs: { microphone: 160, remote: 0 } });
  await pauses.resume({ pauseId: 1, starts: { microphone: 16160, remote: 16000 } });
  await store.put({ version: 1, sessionId: 'analysis', epoch: 0, source: 'microphone', seq: 1, startFrame: 16160,
    sampleRate: 16000, channels: 1, frames: 160 }, Buffer.alloc(320));
  await sealRecording({ store, sessionId: 'analysis', cutoffs: { microphone: 16320, remote: 16000 } });
  const windows = [];
  const execute = async (operation, input) => {
    if (operation === 'plan-summary') return [input.transcript];
    if (operation !== 'transcribe') return candidate(input.transcript);
    windows.push([input.window.startFrame, input.window.samples.length]);
    return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone',
      start: input.window.startFrame / 16000, end: (input.window.startFrame + input.window.samples.length) / 16000,
      rawText: '검증 음성', flags: [] }];
  };
  const result = await analyzeRecording({ root, models, execute });
  assert.deepEqual(windows, [[0, 160], [16160, 160]]);
  assert.deepEqual(result.transcript.segments.map(s => [s.start, s.end]), [[0, .01], [1.01, 1.02]]);
  assert.equal(result.needsReview, false);
  assert.ok(result.summary);
  assert.deepEqual(result.transcript.pauses, [{ pauseId: 1, source: 'microphone', start: .01, end: 1.01 }]);
  assert.match(meetingMarkdown('analysis', result), /사용자 일시정지/);
  assert.match(meetingMarkdown('analysis', result), /0\.010–1\.010초/);
  const invalid = structuredClone(result); invalid.transcript.pauses[0].end = -.1;
  assert.throws(() => meetingMarkdown('analysis', invalid), /pause/);
  assert.deepEqual(await analyzeRecording({ root, models, execute }), result);
  assert.equal(windows.length, 2);
});

test('speech decisions persist, exclude evidence, and reset after transcript correction without rerunning STT', async t => {
  const root = await fixture(t), calls = [];
  const execute = async (operation, input) => {
    calls.push(operation);
    if (operation === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01,
      rawText: 'Send report.', flags: ['speech-unconfirmed'] }];
    if (operation === 'plan-summary') return [input.transcript];
    return candidate(input.transcript);
  };
  const first = await analyzeRecording({ root, models, execute });
  const store = new ReviewStore(join(root, 'speech-reviews'));
  const key = speechReviewKey(first.transcript, first.transcript.segments[0]);
  await store.set(key, 'accepted');
  const accepted = await analyzeRecording({ root, models, execute });
  assert.equal(accepted.needsReview, false); assert.equal(accepted.summary.items.length, 1);
  assert.equal(accepted.transcript.segments[0].speechReview, 'accepted');
  await store.set(key, 'candidate');
  assert.equal((await analyzeRecording({ root, models, execute })).needsReview, true);
  await store.set(key, 'rejected');
  const excluded = await analyzeRecording({ root, models, execute });
  assert.equal(excluded.summary, null); assert.equal(excluded.needsReview, false);
  assert.equal(excluded.transcript.segments[0].rawText, 'Send report.');
  await new CorrectionStore(join(root, 'corrections')).save(excluded.transcript, excluded.transcript.segments[0].id, 'Send budget.');
  const edited = await analyzeRecording({ root, models, execute });
  assert.equal(edited.needsReview, true);
  assert.equal(edited.transcript.segments[0].speechReview, 'candidate');
  assert.notEqual(speechReviewKey(edited.transcript, edited.transcript.segments[0]), key);
  assert.equal(calls.filter(op => op === 'transcribe').length, 1);
});
test('complete recording runs validated transcription and summary; repeat uses persisted results', async t => {
  const root = await fixture(t);
  let calls = 0;
  const execute = async (operation, input) => {
    calls++;
    if (operation === 'plan-summary') return [input.transcript];
    if (operation === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01, rawText: 'Send report.', flags: [] }];
    return { version: 1, revision: 1, items: [{ kind: 'action', status: 'candidate', text: 'Send report.', evidence: [{ segmentId: input.transcript.segments[0].id, quote: 'Send report.' }] }] };
  };
  const first = await analyzeRecording({ root, models, execute, language: 'en' });
  assert.equal(first.summary.items.length, 1);
  assert.equal(calls, 3);
  assert.deepEqual(await analyzeRecording({ root, models, execute, language: 'en' }), first);
  assert.equal(calls, 3);
});

test('corrected revision reuses original STT but generates a new plan and evidence-linked summary', async t => {
  const root = await fixture(t), calls = [];
  const execute = async (operation, input) => {
    calls.push(operation);
    if (operation === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01, rawText: 'Monday', flags: [] }];
    if (operation === 'plan-summary') return [input.transcript];
    return { ...candidate(input.transcript), revision: input.transcript.revision };
  };
  const first = await analyzeRecording({ root, models, execute });
  await new CorrectionStore(join(root, 'corrections')).save(first.transcript, first.transcript.segments[0].id, 'Friday');
  calls.length = 0;
  const updated = await analyzeRecording({ root, models, execute });
  assert.deepEqual(calls, ['plan-summary', 'summarize']);
  assert.equal(updated.transcript.revision, 2);
  assert.equal(updated.summary.revision, 2);
  assert.equal(updated.summary.items[0].evidence[0].quote, 'Friday');
  assert.equal(updated.transcript.segments[0].originalRawText, 'Monday');
});
test('incomplete audio never reaches inference', async t => {
  const root = await fixture(t, false);
  await assert.rejects(analyzeRecording({ root, models, execute: () => { assert.fail('must not infer'); } }), /complete/);
});
test('cancelled result is not reused on retry', async t => {
  const root = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(analyzeRecording({ root, models, signal: controller.signal, execute: async () => {
    controller.abort(); return [];
  } }), { name: 'AbortError' });
  let called = false;
  await assert.rejects(analyzeRecording({ root, models, execute: async () => { called = true; throw new Error('retry reached'); } }), /retry reached/);
  assert.equal(called, true);
});

test('summary validation failure preserves transcript and never marks a summary complete', async t => {
  const root = await fixture(t);
  const result = await analyzeRecording({ root, models, execute: async (operation, input) => {
    if (operation === 'plan-summary') return [input.transcript];
    if (operation === 'summarize') return { invalid: true };
    return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01, rawText: 'Send report.', flags: [] }];
  } });
  assert.equal(result.transcript.segments.length, 1);
  assert.equal(result.summary, null);
  assert.ok(result.summaryError);
});

test('partial summary survives a fresh analysis and retries only the failed partition', async t => {
  const root = await fixture(t), calls = [];
  let fail = true;
  const execute = async (operation, input) => {
    calls.push([operation, input.partIndex]);
    if (operation === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01, rawText: 'Send report.', flags: [] }];
    if (operation === 'plan-summary') return ['Send ', 'report.'].map(rawText => ({ revision: 1, segments: [{ id: input.transcript.segments[0].id, rawText }] }));
    if (operation === 'reconcile') return { version: 1, revision: 1, items: input.reconciliation.candidates.map(c => ({ ...c.item, candidateIds: [c.id] })) };
    if (input.partIndex === 1 && fail) throw new Error('GPU lost');
    return candidate(input.transcript);
  };
  const partial = await analyzeRecording({ root, models, execute });
  assert.equal(partial.summary, null);
  assert.equal(partial.summaryParts.state, 'partial');
  assert.equal(partial.summaryParts.total, 2);
  assert.equal(partial.summaryParts.parts.length, 1);
  assert.equal(partial.summaryError, 'GPU lost');
  fail = false; calls.length = 0;
  const complete = await analyzeRecording({ root, models, execute });
  assert.deepEqual(calls, [['summarize', 1], ['reconcile', undefined]]);
  assert.equal(complete.summaryParts.state, 'complete');
  assert.equal(complete.summaryParts.parts.length, 2);
  assert.equal(complete.reconciliation.state, 'complete');
  assert.equal(complete.summary.items.length, 2);
  calls.length = 0;
  assert.deepEqual(await analyzeRecording({ root, models, execute }), complete);
  assert.deepEqual(calls, []);
});

test('invalid reconciliation preserves parts and retries only reconciliation; cancellation never caches a late result', async t => {
  const root = await fixture(t), calls = [];
  let mode = 'invalid', controller;
  const execute = async (operation, input) => {
    calls.push(operation);
    if (operation === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01, rawText: 'Monday Friday', flags: [] }];
    if (operation === 'plan-summary') return ['Monday ', 'Friday'].map(rawText => ({ revision: 1, segments: [{ id: input.transcript.segments[0].id, rawText }] }));
    if (operation === 'summarize') return candidate(input.transcript);
    assert.equal(operation, 'reconcile');
    if (mode === 'context') throw Object.assign(new Error('input exceeds model context'), { code: 'CONTEXT_LIMIT' });
    const output = { version: 1, revision: 1, items: input.reconciliation.candidates.map(c => ({ ...c.item, candidateIds: [c.id] })) };
    if (mode === 'invalid') output.items.pop();
    if (mode === 'cancel') controller.abort();
    return output;
  };
  const failed = await analyzeRecording({ root, models, execute });
  assert.equal(failed.summary, null);
  assert.equal(failed.summaryParts.parts.length, 2);
  assert.equal(failed.summaryParts.state, 'complete');
  assert.equal(failed.reconciliation.state, 'failed');
  assert.match(failed.summaryError, /omitted/);
  assert.equal(failed.summaryErrorCode, undefined);
  mode = 'context'; calls.length = 0;
  const oversized = await analyzeRecording({ root, models, execute });
  assert.equal(oversized.summaryErrorCode, 'CONTEXT_LIMIT');
  assert.deepEqual(oversized.transcript, failed.transcript);
  assert.deepEqual(oversized.summaryParts, failed.summaryParts);
  assert.equal(oversized.summary, null);
  assert.deepEqual(calls, ['reconcile']);
  calls.length = 0;
  mode = 'cancel'; controller = new AbortController();
  await assert.rejects(analyzeRecording({ root, models, execute, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, ['reconcile']);
  mode = 'valid'; calls.length = 0;
  const complete = await analyzeRecording({ root, models, execute });
  assert.deepEqual(calls, ['reconcile']);
  assert.equal(complete.reconciliation.state, 'complete');
  assert.equal(complete.summary.items.length, 2);
  calls.length = 0;
  assert.deepEqual(await analyzeRecording({ root, models, execute }), complete);
  assert.deepEqual(calls, []);
  const changedModels = { ...models, summary: { modelHash: 'c'.repeat(64) } };
  const changed = await analyzeRecording({ root, models: changedModels, execute });
  assert.deepEqual(calls, ['plan-summary', 'summarize', 'summarize', 'reconcile']);
  assert.equal(changed.reconciliation.state, 'complete');
});

test('apple STT rejects analysis language that does not match installed locale', async t => {
  const root = await fixture(t);
  const apple = { backend: 'apple', locale: 'ko-KR', preset: 'offlineTranscription', modelHash: 'e'.repeat(64) };
  await assert.rejects(analyzeRecording({ root, models: { stt: apple, summary: models.summary }, language: 'en',
    execute: async () => assert.fail('must not transcribe') }), /locale/);
});

test('a plan that omits text never reaches summary generation or becomes reusable', async t => {
  const root = await fixture(t);
  let plans = 0;
  const execute = async (operation, input) => {
    if (operation === 'transcribe') return [{ id: `${input.key}:0`, jobId: input.key, source: 'microphone', start: 0, end: .01, rawText: 'Send report.', flags: [] }];
    if (operation === 'plan-summary') { plans++; return []; }
    assert.fail('must not summarize an invalid plan');
  };
  for (let i = 0; i < 2; i++) {
    const result = await analyzeRecording({ root, models, execute });
    assert.match(result.summaryError, /omitted/);
    assert.equal(result.transcript.segments.length, 1);
  }
  assert.equal(plans, 2);
});
