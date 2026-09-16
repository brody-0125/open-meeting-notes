import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { sealRecording } from '../../src/recording-seal.mjs';

test('speech decisions control summary, persist across restart, and reset on correction', { timeout: 60000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE);
  const directory = await mkdtemp(join(tmpdir(), 'omn-speech-review-'));
  let app, page; const errors = [];
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const launch = async () => {
    app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
      env: { ...process.env, OMN_VAD_FIXTURE: '', OMN_APP_TEST_DIRECTORY: directory } });
    page = await app.firstWindow();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (['error', 'warning'].includes(e.type())) errors.push(e.text()); });
    assert.equal(page.url(), 'omn://app/index.html'); assert.equal(await page.title(), 'open-meeting-notes');
    await page.evaluate(() => {
      globalThis.operations = []; globalThis.requests = [];
      window.meeting.onInferenceRequest(message => requests.push(message));
      // Model quality is separate; persistent jobs, review stores, Main and UI are real.
      globalThis.Worker = class {
        postMessage({ id, operation, input }) {
          operations.push(operation);
          const transcript = input.transcript;
          const result = operation === 'transcribe' ? [{ id: `${input.audio.jobId}:0`, jobId: input.audio.jobId,
            source: 'microphone', start: 0, end: 1, rawText: '보고서를 보냅니다.', flags: [] }]
            : operation === 'plan-summary' ? [transcript]
            : { version: 1, revision: transcript.revision, items: [{ kind: 'action', status: 'candidate',
              text: transcript.segments[0].rawText, evidence: [{ segmentId: transcript.segments[0].id, quote: transcript.segments[0].rawText }] }] };
          queueMicrotask(() => this.onmessage?.({ data: { id, type: 'result', result } }));
        }
        terminate() {}
      };
    });
  };
  await launch();
  const id = '99999999-9999-4999-8999-999999999999', store = new ChunkStore(join(directory, 'recordings', id));
  const pcm = Buffer.alloc(32000, 1);
  await store.put({ version: 1, sessionId: id, source: 'microphone', epoch: 0, seq: 0, startFrame: 0,
    sampleRate: 16000, channels: 1, frames: 16000 }, pcm);
  await sealRecording({ store, sessionId: id, cutoffs: { microphone: 16000, remote: 0 } });
  const analyze = async () => {
    await page.getByRole('button', { name: '목록 새로고침' }).click();
    await page.getByRole('button', { name: '전사·요약', exact: true }).click();
    await page.locator('#analysis-export').waitFor({ state: 'visible' });
  };
  await analyze();
  assert.equal(await page.getByLabel('전사 사용 판단', { exact: true }).inputValue(), 'candidate');
  const oldRun = await page.evaluate(() => requests[0].runId);
  await assert.rejects(page.evaluate(run => window.meeting.reviewTranscript(run, '../unknown', 'accepted'), oldRun));
  const choose = async state => {
    await page.getByLabel('전사 사용 판단', { exact: true }).selectOption(state);
    await page.waitForFunction(expected => document.querySelector('.speech-review-choice')?.value === expected &&
      !document.querySelector('#analysis-export').hidden && !document.querySelector('.speech-review-choice').disabled, state);
  };
  await choose('accepted');
  assert.equal(await page.locator('#summary blockquote').count(), 1);
  assert.match(await page.locator('#transcript').innerText(), /사용자 판단: 요약에 사용/);
  await assert.rejects(page.evaluate(run => window.meeting.exportAnalysis(run), oldRun), /stale/);
  await page.getByRole('button', { name: 'Markdown 저장' }).click();
  const saved = page.locator('#export-status').filter({ hasText: '이 기기에 저장했습니다:' }); await saved.waitFor();
  assert.match(await readFile((await saved.innerText()).replace('이 기기에 저장했습니다: ', ''), 'utf8'), /사용자가 요약 근거로 사용/);
  const screenshots = fileURLToPath(new URL('../../../quality/speech-review/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.locator('#analysis').screenshot({ path: join(screenshots, 'accepted.png') });
  await choose('rejected'); assert.equal(await page.locator('#summary blockquote').count(), 0);
  assert.match(await page.locator('#analysis-status').innerText(), /사용자 판단으로 모든 전사를 요약에서 제외/);
  await app.close(); app = undefined; await launch(); await analyze();
  assert.equal(await page.getByLabel('전사 사용 판단', { exact: true }).inputValue(), 'rejected');
  assert.deepEqual(await page.evaluate(() => operations), []);
  await page.getByText('전사 수정', { exact: true }).click();
  await page.getByLabel('전사 문장 수정', { exact: true }).fill('예산을 보냅니다.');
  await page.getByRole('button', { name: '수정 저장 후 재요약', exact: true }).click();
  await page.locator('#analysis[data-revision="2"]').waitFor();
  assert.equal(await page.getByLabel('전사 사용 판단', { exact: true }).inputValue(), 'candidate');
  assert.equal(await page.locator('#summary blockquote').count(), 0);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#analysis').screenshot({ path: join(screenshots, 'recheck.png') });
  assert.deepEqual((await store.recover()).chunks[0].pcm, pcm);
  assert.deepEqual(errors, []);
});
