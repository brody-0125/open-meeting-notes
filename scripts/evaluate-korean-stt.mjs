import { _electron as electron } from 'playwright';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { characterErrors, literalChecks } from '../src/stt-quality.mjs';
const [speechArgument, reportArgument, modelId = 'whisper-tiny'] = process.argv.slice(2);
if (!['whisper-tiny', 'whisper-small'].includes(modelId)) throw new Error('unsupported evaluation model');
if (!speechArgument || !reportArgument || !process.env.OMN_STT_FIXTURE) throw new Error('usage: evaluate-korean-stt.mjs speech-directory report.json; OMN_STT_FIXTURE required');
const speech = resolve(speechArgument), reportPath = resolve(reportArgument);
const corpusBytes = await readFile(new URL('../test/fixtures/korean-stt.json', import.meta.url));
const corpus = JSON.parse(corpusBytes), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const approval = JSON.parse(await readFile(join(process.env.OMN_STT_FIXTURE, 'fixture-approval.json'), 'utf8'));
const root = await mkdtemp(join(tmpdir(), 'omn-korean-eval-'));
let app;
try {
  app = await electron.launch({ args: [fileURLToPath(new URL('../test/electron/main.mjs', import.meta.url))], env: { ...process.env,
    OMN_TEST_PROFILE: join(root, 'profile'), OMN_TEST_AUDIO: join(root, 'audio'), OMN_SUMMARY_FIXTURE: '', OMN_VAD_FIXTURE: '' } });
  const page = await app.firstWindow();
  await page.evaluate(async () => { const { InferenceClient } = await import('/inference-client.mjs'); globalThis.qualityClient = new InferenceClient(); });
  const cases = [];
  for (const item of corpus) {
    const wav = await readFile(join(speech, `${item.id}.wav`));
    const result = await page.evaluate(async ({ id, bytes, modelId }) => {
      const context = new AudioContext({ sampleRate: 16000 });
      const decoded = await context.decodeAudioData(new Uint8Array(bytes).buffer);
      const samples = decoded.getChannelData(0).slice(); await context.close();
      const start = performance.now();
      const segments = await globalThis.qualityClient.run('transcribe', { modelId, language: 'ko', audio: {
        jobId: id, source: 'microphone', startFrame: 0, sampleRate: 16000, samples
      } });
      return { hypothesis: segments.map(s => s.rawText).join(' '), seconds: samples.length / 16000,
        inferenceMs: performance.now() - start, segments };
    }, { id: item.id, bytes: [...wav], modelId });
    const scored = { id: item.id, reference: item.text, audioSha256: sha(wav), ...result,
      ...characterErrors(item.text, result.hypothesis), literalChecks: literalChecks(result.hypothesis, item.checks) };
    cases.push(scored);
    console.log(`${item.id}: CER ${(scored.cer * 100).toFixed(1)}%, missing literals ${scored.literalChecks.filter(c => !c.present).length}`);
  }
  await page.evaluate(() => globalThis.qualityClient.dispose());
  const edits = cases.reduce((n, c) => n + c.edits, 0), characters = cases.reduce((n, c) => n + c.referenceCharacters, 0);
  const report = { version: 1, createdAt: new Date().toISOString(), model: modelId, dtype: 'q8', device: 'wasm',
    engine: '@huggingface/transformers@4.3.0', language: 'ko', modelManifestHash: approval.manifestHash,
    corpusSha256: sha(corpusBytes), speechVoice: 'Microsoft Heami Desktop',
    normalization: 'NFKC; lowercase; retain Unicode letters and numbers only; no numeric verbalization equivalence for CER',
    limitations: ['Synthetic single-voice speech; not human meeting evaluation', 'Literal presence is not semantic correctness', 'First inference timing includes model load', 'No release threshold selected from this tiny corpus'],
    totalEdits: edits, totalReferenceCharacters: characters, microCer: edits / characters, cases };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  const fence = text => { let n = 3; for (const m of text.matchAll(/`+/g)) n = Math.max(n, m[0].length + 1); return `${'`'.repeat(n)}text\n${text}\n${'`'.repeat(n)}`; };
  const lines = ['# 한국어 STT 합성 음성 기준선', '', `${modelId} q8/WASM · 한국어 · Microsoft Heami Desktop · ${cases.length}개 문장`, '',
    `문자 오류율(CER): **${(report.microCer * 100).toFixed(2)}%** (${edits}/${characters}).`, '',
    '이 수치는 실제 회의 품질 합격을 뜻하지 않습니다. 단일 합성 음성의 소규모 기준선이며 잡음·중첩 발화·다양한 화자를 포함하지 않습니다. 핵심 표현 검사는 문자열 존재 여부이고 의미·담당자 관계·부정 범위를 검증하지 않습니다.', '',
    'CER는 NFKC·소문자 변환 후 문자·숫자만 남겨 계산합니다. 숫자의 발음 표기와 아라비아 숫자는 CER에서 같은 값으로 처리하지 않습니다. 핵심 표현 검사에 명시한 대안만 별도로 허용합니다.', ''];
  for (const c of cases) lines.push(`## ${c.id}`, '', `CER ${(c.cer * 100).toFixed(1)}% · 음성 ${c.seconds.toFixed(2)}초 · 누락된 검사 표현: ${c.literalChecks.filter(x => !x.present).map(x => x.label).join(', ') || '없음'}`, '', '기준 문장:', fence(c.reference), '', '모델 전사:', fence(c.hypothesis), '');
  lines.push('원시 JSON에는 모델 manifest·corpus·음성 파일 hash, 개별 전사 구간과 시각, 지표를 보존했습니다. 첫 추론 시간에는 모델 로딩이 포함됩니다. 이번 자료만으로 출시 threshold를 정하지 않습니다.');
  await writeFile(reportPath.replace(/\.json$/, '') + '.md', lines.join('\n'));
  console.log(JSON.stringify({ reportPath, microCer: report.microCer }));
} finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
