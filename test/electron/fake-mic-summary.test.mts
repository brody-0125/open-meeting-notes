import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { inspectRecording } from '../../src/recording-seal.mjs';
import { judgeSummaries, validateVerdict } from '../../tools/summary-judge.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('fake WAV microphone → durable recording → real Korean STT/summary → calibrated independent LLM judge', { timeout: 600000 }, async t => {
  const parent = resolve(process.env.OMN_FAKE_MIC_REPORT_DIR || tmpdir());
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, 'omn-fake-mic-summary-'));
  const report = { passed: false, stage: 'setup', output, packs: {}, checks: {}, errors: [], console: [] };
  t.diagnostic(`Evidence directory: ${output}`);
  let app;
  const close = async () => {
    if (!app) return;
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {}); app = undefined;
  };
  t.after(async () => { await close(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); });
  try {
    const env = { ...process.env };
    for (const [kind, key] of [['stt', 'OMN_STT_FIXTURE'], ['summary', 'OMN_SUMMARY_FIXTURE'], ['vad', 'OMN_VAD_FIXTURE']]) {
      env[key] = resolve(env[key] || join(repo, 'models/packs', kind));
      const approval = JSON.parse(await readFile(join(env[key], 'fixture-approval.json'), 'utf8'));
      report.packs[kind] = { root: env[key], ...approval };
    }
    const corpus = await readFile(join(repo, 'test/fixtures/meeting-summary.json'));
    const [scenario] = JSON.parse(corpus.toString('utf8'));
    const wavPath = join(repo, 'test/fixtures', `${scenario.id}.wav`), wav = await readFile(wavPath);
    assert.equal(sha(wav), (await readFile(`${wavPath}.sha256`, 'utf8')).trim());
    report.scenario = { ...scenario, corpusSha256: sha(corpus), wavSha256: sha(wav) };
    const directory = join(output, 'app');
    app = await electron.launch({ args: [join(repo, 'test/electron/app-model-main.mjs'),
      '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}%noloop`],
      env: { ...env, OMN_APP_TEST_DIRECTORY: directory } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push(m.text()); });
    report.runtime = await app.evaluate(({ dialog }) => {
      // Only the native consent dialog is automated; the production permission gate stays active.
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      return { electron: process.versions.electron, chromium: process.versions.chrome };
    });
    assert.equal(page.url(), 'omn://app/index.html');
    assert.equal(await page.title(), 'open-meeting-notes');
    report.models = await page.evaluate(() => window.meeting.models());
    assert.equal(report.models.error, null);
    assert.equal(report.models.stt.modelId, 'whisper-small');
    for (const kind of ['stt', 'summary', 'vad']) assert.equal(report.models[kind].modelHash, report.packs[kind].manifestHash);
    const duration = await page.evaluate(async bytes => {
      const context = new AudioContext();
      try { return (await context.decodeAudioData(new Uint8Array(bytes).buffer)).duration; }
      finally { await context.close(); }
    }, [...wav]);
    assert.ok(duration > 10 && duration < 29, 'this baseline must fit within a single 30-second transcription window');
    report.wavSeconds = duration;
    assert.equal(await page.evaluate(async () => {
      try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop()); return 'granted'; }
      catch (e) { return e.name; }
    }), 'NotAllowedError');
    await page.evaluate(() => {
      globalThis.nativeMicrophone = navigator.mediaDevices.getUserMedia;
      globalThis.operations = [];
      window.meeting.onInferenceRequest(message => operations.push(message.operation));
      // The case covers the microphone. A silent remote stream avoids OS picker/loopback dependencies.
      navigator.mediaDevices.getDisplayMedia = async () => {
        globalThis.remoteContext = new AudioContext();
        const tone = new OscillatorNode(remoteContext), gain = new GainNode(remoteContext, { gain: 0 });
        const destination = remoteContext.createMediaStreamDestination();
        tone.connect(gain).connect(destination); tone.start(); await remoteContext.resume();
        return destination.stream;
      };
    });
    await page.waitForFunction(() => !document.getElementById('silence-enabled').disabled);
    await page.locator('#silence-enabled').uncheck();
    report.stage = 'capture'; t.diagnostic('Recording the pinned WAV through native getUserMedia');
    await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
    const acquisitionAt = performance.now();
    await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
    await page.getByText('입력 확인 중', { exact: true }).waitFor();
    assert.deepEqual(await readdir(join(directory, 'recordings')), []);
    await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
    await page.getByText('녹음 중', { exact: true }).waitFor();
    const recordingAt = performance.now();
    report.preflightMs = recordingAt - acquisitionAt;
    assert.ok(report.preflightMs < scenario.leadSilenceMs - 1000, 'preflight consumed the speech; increase fixture lead silence');
    await page.waitForFunction(() => document.getElementById('microphone-level').value > -45, null, { timeout: 15000 });
    // Wait from actual recording state, not the input-selection click. Device
    // acquisition latency must not cut off the last spoken fact.
    await page.waitForTimeout(Math.max(0, duration * 1000 + 250 - (performance.now() - recordingAt)));
    await page.getByRole('button', { name: '녹음 종료', exact: true }).click();
    await page.getByText('녹음 저장 완료', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.nativeMicrophone === navigator.mediaDevices.getUserMedia), true);
    await page.evaluate(() => remoteContext.close());
    const ids = await readdir(join(directory, 'recordings')); assert.equal(ids.length, 1);
    const recordingRoot = join(directory, 'recordings', ids[0]);
    const recovered = await new ChunkStore(recordingRoot).recover();
    assert.deepEqual(recovered.errors, []);
    const mic = recovered.chunks.filter(c => c.meta.source === 'microphone');
    assert.ok(mic.some(c => c.pcm.some(byte => byte !== 0)));
    assert.equal((await inspectRecording(recordingRoot)).state, 'complete');
    const micFrames = mic.reduce((n, c) => n + c.meta.frames, 0);
    report.recording = { id: ids[0], root: recordingRoot, micFrames, sampleRate: mic[0].meta.sampleRate };
    assert.ok(micFrames / mic[0].meta.sampleRate < 30, 'capture exceeded the single-window baseline');
    report.checks.capture = true;

    report.stage = 'analysis'; t.diagnostic('Running production STT and summary through the UI');
    await page.locator('#analysis-language').selectOption('ko');
    await page.getByRole('button', { name: '전사·요약', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('analysis-export').hidden ||
      document.getElementById('analysis-status').textContent.startsWith('분석을 완료하지 못했습니다'), null, { timeout: 240000 });
    report.analysisStatus = await page.locator('#analysis-status').innerText();
    report.transcript = (await page.locator('#transcript > li > p').allTextContents()).join('\n');
    // Exclude evidence blockquotes: a wrong summary must not pass because its source quote is correct.
    report.summary = (await page.locator('#summary > li > p').allTextContents()).join('\n');
    report.operations = await page.evaluate(() => operations);
    await writeFile(join(output, 'transcript.txt'), report.transcript);
    await writeFile(join(output, 'summary.txt'), report.summary);
    report.checks.analysis = /전사·(?:통합 )?요약 완료/.test(report.analysisStatus) &&
      report.operations.includes('transcribe') && report.operations.includes('summarize') &&
      Boolean(report.transcript.trim() && report.summary.trim());
    assert.deepEqual(report.errors, []);
    await page.locator('#tab-summary').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#analysis-status').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, 'summary.png') });
    await close();

    report.stage = 'judge'; t.diagnostic('Evaluating positive, contradiction, omission controls and actual summary with independent Codex judge');
    report.candidateLabels = ['reference', 'contradictions', 'missing-date', 'minor-typos', 'changed-task', 'transcript', 'summary'];
    const candidates = [scenario.referenceSummary, scenario.negativeControl, scenario.omissionControl,
      scenario.typoControl, scenario.changedTaskControl, report.transcript, report.summary];
    report.judge = await judgeSummaries(scenario.criteria, candidates, output, scenario.text);
    const passes = report.judge.results.map((r, i) => validateVerdict(r.verdict, scenario.criteria, candidates[i]));
    assert.equal(passes[0], true, 'judge rejected the positive reference control');
    assert.equal(passes[1], false, 'judge accepted the deliberately wrong control');
    for (const id of ['report', 'guide', 'budget', 'public'])
      assert.notEqual(report.judge.results[1].verdict.checks[id].verdict, 'supported', `judge missed negative control: ${id}`);
    assert.equal(passes[2], false, 'judge accepted the missing-date control');
    assert.equal(report.judge.results[2].verdict.checks.launch.verdict, 'missing');
    assert.equal(passes[3], true, 'judge treated recoverable spelling errors as changed facts');
    assert.ok(report.judge.results[3].verdict.warnings.length > 0, 'judge silently ignored typo-control quality issues');
    assert.equal(passes[4], false, 'judge accepted a genuinely different task');
    assert.equal(report.judge.results[4].verdict.checks.report.verdict, 'contradicted');
    report.checks.judgeCalibration = true;
    report.checks.semanticTranscript = passes[5];
    report.checks.semanticSummary = passes[6];
    report.qualityWarnings = { transcript: report.judge.results[5].verdict.warnings, summary: report.judge.results[6].verdict.warnings };
    report.failureStage = !report.checks.analysis ? 'analysis' : !passes[5] ? 'transcription' : !passes[6] ? 'summary' : null;
    assert.equal(report.checks.analysis, true, `production analysis failed: ${report.analysisStatus}`);
    assert.equal(passes[5], true, 'actual transcript changed or omitted required facts; inspect report.json');
    assert.equal(passes[6], true, 'actual summary failed semantic criteria; inspect report.json');
    report.passed = true; report.stage = 'complete';
  } catch (error) { report.failure = error.message; throw error; }
});
