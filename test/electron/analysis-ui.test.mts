import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';
import { installInferenceDouble } from '../../tools/testing/inference-double.mjs';

test('output limit crosses Worker/client/IPC, preserves partial jobs, and retry only computes missing work', { timeout: 60000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE && process.env.OMN_VAD_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-output-limit-ui-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  assert.equal(page.url(), 'omn://app/index.html');
  assert.equal(await page.title(), 'open-meeting-notes');
  const id = '55555555-5555-4555-8555-555555555555';
  const store = new ChunkStore(join(directory, 'recordings', id)), pcm = Buffer.alloc(32000, 1);
  await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 0,
    startFrame: 0, frames: 16000, sampleRate: 16000, channels: 1 }, pcm);
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 16000, remote: 0 } });
  await page.evaluate(() => {
    globalThis.failSummary = true;
    globalThis.badSource = true;
    globalThis.inferenceHandlers = {
      'measure-speech': ({ audio }) => ({ speechRanges: [{ startFrame: 0, endFrame: audio.samples.length }] }),
      transcribe: ({ audio }) => {
        if (!(audio.samples instanceof Float32Array) || audio.sampleRate !== 16000 || audio.source !== 'microphone')
          throw new Error('unexpected transcription audio');
        return ['보고서를 검토합니다.', '예산 승인은 보류합니다.'].map((rawText, i) => ({
          id: `${audio.jobId}:${i}`, jobId: audio.jobId, source: globalThis.badSource ? 'remote' : audio.source,
          start: i * .5, end: (i + 1) * .5, rawText, flags: []
        }));
      },
      'plan-summary': ({ transcript }) => transcript.segments.map(segment => ({ revision: transcript.revision, segments: [segment] })),
      summarize: ({ transcript }) => {
        const segment = transcript.segments[0];
        if (globalThis.failSummary && segment.rawText.includes('예산'))
          throw Object.assign(new Error('incomplete summary generation (length)'), { code: 'OUTPUT_LIMIT' });
        return { version: 1, revision: transcript.revision, items: [{ kind: 'topic', text: segment.rawText,
          status: 'candidate', evidence: [{ segmentId: segment.id, quote: segment.rawText }] }] };
      },
      reconcile: ({ reconciliation }) => ({ version: 1, revision: reconciliation.revision,
        items: reconciliation.candidates.map(({ id, item }) => ({ ...item, candidateIds: [id] })) })
    };
  });
  await page.evaluate(installInferenceDouble);
  const analyze = async (exportable = true) => {
    await page.getByRole('button', { name: '목록 새로고침' }).click();
    await page.getByRole('button', { name: '전사·요약', exact: true }).click();
    await page.locator('#analysis-cancel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#analysis-export').isVisible(), exportable);
  };
  // A plausible but wrong-source model result must fail the product validator,
  // not silently populate the cache merely because the double returned it.
  await analyze(false);
  assert.match(await page.locator('#analysis-status').textContent(), /invalid transcript result/);
  const failedJobs = await readdir(join(store.root, 'jobs')).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  assert.deepEqual(failedJobs.filter(name => name.endsWith('.json')), []);
  await page.evaluate(() => { globalThis.badSource = false; });
  await analyze();
  assert.match(await page.locator('#analysis-status').textContent(), /요약 출력 한도에 도달했습니다.*전사와 완료된 구간 요약은 보존됩니다/);
  assert.match(await page.locator('#analysis-status').textContent(), /1\/2/);
  assert.equal(await page.locator('#transcript > li').count(), 2);
  assert.equal(await page.locator('#summary blockquote').count(), 1);
  assert.match(await page.locator('#summary').textContent(), /보고서를 검토합니다/);
  const operations = () => page.evaluate(() => inferenceDouble.requests.map(r => r.operation));
  const first = await operations();
  assert.deepEqual(first, ['measure-speech', 'transcribe', 'measure-speech', 'transcribe', 'plan-summary', 'summarize', 'summarize']);
  // Export also validates real persisted evidence, not a hand-built render fixture.
  await page.getByRole('button', { name: 'Markdown 저장' }).click();
  await page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }).waitFor();
  const path = (await page.locator('#export-status').innerText()).replace('이 기기에 저장했습니다: ', '');
  const partialMarkdown = await readFile(path, 'utf8');
  assert.match(partialMarkdown, /상태: 부분 완료: 1\/2/);
  assert.match(partialMarkdown, /incomplete summary generation \(length\)/);
  assert.match(partialMarkdown, /보고서를 검토합니다/);
  await page.evaluate(() => { globalThis.failSummary = false; });
  await analyze();
  assert.match(await page.locator('#analysis-status').textContent(), /통합 요약 완료/);
  assert.equal(await page.locator('#summary blockquote').count(), 2);
  assert.deepEqual(await operations(), [...first, 'summarize', 'reconcile']);
  await analyze();
  assert.deepEqual(await operations(), [...first, 'summarize', 'reconcile']);
  assert.deepEqual((await store.recover()).chunks[0].pcm, pcm);
  assert.deepEqual(await page.evaluate(() => inferenceDouble.unexpected), []);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(tmpdir(), 'omn-analysis-double-retry.png'), fullPage: true });
});

test('recording list → real STT/summary UI, cancellation and cached retry', { timeout: 180000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-analysis-ui-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The versioned corpus belongs to the test, not an optional copy in a model pack.
  const wav = await readFile(new URL('../fixtures/speech.wav', import.meta.url));
  const samples = await page.evaluate(async bytes => {
    const ctx = new AudioContext({ sampleRate: 16000 });
    const audio = await ctx.decodeAudioData(new Uint8Array(bytes).buffer);
    const samples = Array.from(audio.getChannelData(0)); await ctx.close();
    globalThis.inferenceRequests = 0;
    window.meeting.onInferenceRequest(() => { globalThis.inferenceRequests++; });
    return samples;
  }, [...wav]);
  const id = '22222222-2222-4222-8222-222222222222';
  const store = new ChunkStore(join(directory, 'recordings', id));
  for (let frame = 0, seq = 0; frame < samples.length; frame += 80000, seq++) {
    const frames = Math.min(80000, samples.length - frame), pcm = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) { const value = Math.max(-1, Math.min(1, samples[frame + i])); pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2); }
    await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq, startFrame: frame, frames, sampleRate: 16000, channels: 1 }, pcm);
  }
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: samples.length, remote: 0 } });
  await page.getByRole('button', { name: '목록 새로고침' }).click();
  await page.locator('#analysis-language').selectOption('en');
  await page.getByRole('button', { name: '전사·요약', exact: true }).click();
  await page.getByRole('button', { name: '분석 취소' }).click();
  await page.getByText('분석을 취소했습니다. 완료된 작업은 다시 사용할 수 있습니다.').waitFor();
  await page.getByRole('button', { name: '전사·요약', exact: true }).click();
  // Wait for a terminal state so processing failures surface immediately,
  // rather than spending the whole timeout waiting for success text.
  await page.locator('#analysis-cancel').waitFor({ state: 'hidden', timeout: 120000 });
  assert.equal(await page.locator('#analysis-status').innerText(), '전사·요약 완료 · 요약 후보를 원문과 비교해 검토하세요.');
  assert.match(await page.locator('#transcript').innerText(), /report/i);
  assert.ok(await page.locator('#summary blockquote').count() > 0);
  const calls = await page.evaluate(() => globalThis.inferenceRequests);
  assert.ok(calls >= 3);
  await page.getByRole('button', { name: '전사·요약', exact: true }).click();
  await page.getByText('전사·요약 완료 · 요약 후보를 원문과 비교해 검토하세요.').waitFor();
  assert.equal(await page.evaluate(() => globalThis.inferenceRequests), calls);
  await page.locator('.review-choice').first().selectOption('accepted');
  await page.getByText('검토 판단을 이 기기에 저장했습니다.').waitFor();
  await page.getByRole('button', { name: '전사·요약', exact: true }).click();
  await page.getByText('전사·요약 완료 · 요약 후보를 원문과 비교해 검토하세요.').waitFor();
  assert.equal(await page.locator('.review-choice').first().inputValue(), 'accepted');
  assert.equal(await page.evaluate(() => globalThis.inferenceRequests), calls);
  assert.equal(await page.evaluate(async () => {
    try { await window.meeting.reviewAnalysis('stale-run', 0, 0, 'accepted'); return false; } catch { return true; }
  }), true);
  assert.equal(await page.evaluate(async () => {
    try { await window.meeting.exportAnalysis('stale-run'); return false; } catch { return true; }
  }), true);
  await page.getByRole('button', { name: 'Markdown 저장' }).click();
  await page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }).waitFor();
  const savedPath = (await page.locator('#export-status').innerText()).replace('이 기기에 저장했습니다: ', '');
  assert.equal(dirname(savedPath), join(directory, 'exports'));
  const markdown = await readFile(savedPath, 'utf8');
  assert.match(markdown, /사용자 채택/);
  assert.match(markdown, /report/i);
  assert.match(markdown, /근거 ID:/);
  await page.locator('#tab-transcript').click();
  await page.getByText('전사 수정', { exact: true }).first().click();
  await page.getByLabel('전사 문장 수정', { exact: true }).first().fill('Please send the report on Friday.');
  await page.getByRole('button', { name: '수정 저장 후 재요약', exact: true }).first().click();
  await page.locator('#analysis[data-revision="2"]').waitFor({ timeout: 120000 });
  await page.getByText('전사·요약 완료 · 요약 후보를 원문과 비교해 검토하세요.').waitFor({ timeout: 120000 });
  assert.match(await page.locator('#transcript').innerText(), /Friday/);
  assert.equal(await page.locator('.review-choice').first().inputValue(), 'candidate');
  assert.equal(await page.evaluate(() => globalThis.inferenceRequests), calls + 2);
  await page.locator('#tab-transcript').click();
  await page.getByText('모델 전사 원본 보기', { exact: true }).first().click();
  assert.match(await page.locator('#transcript').innerText(), /tomorrow/);
  await page.getByRole('button', { name: 'Markdown 저장' }).click();
  await page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }).waitFor();
  const editedPath = (await page.locator('#export-status').innerText()).replace('이 기기에 저장했습니다: ', '');
  const editedMarkdown = await readFile(editedPath, 'utf8');
  assert.match(editedMarkdown, /전사 revision: 2/);
  assert.match(editedMarkdown, /보존된 모델 전사 원본:/);
  assert.match(editedMarkdown, /Friday/);
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
  assert.deepEqual(errors, []);
  const screenshots = fileURLToPath(new URL('../../../../work/app-qa/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'analysis.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshots, 'analysis-narrow.png'), fullPage: true });
});
