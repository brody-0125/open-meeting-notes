import { InferenceClient } from '/inference-client.mjs';
import { prepareSttAudio } from '/resample.mjs';
import { summaryGroups } from '/summary-groups.mjs';
import { AudioPreview } from '/preview.mjs';
import { markUnconfirmedSpeech } from '/speech-evidence.mjs';
const $ = id => document.getElementById(id);
const bridge = window.meeting;
const preview = new AudioPreview();
const pausesPanel = $('analysis-pauses'), pausesList = $('analysis-pause-list');
bridge.onPlaybackStopped(() => preview.stop());
let active, completedRunId, completedRecordId, completedLanguage;
bridge.onInferenceRequest(async message => {
  const run = active;
  if (!run || message.runId !== run.id || run.cancelled) return;
  try {
    let input = message.input;
    let measurement = null;
    if (message.operation === 'transcribe') {
      $('analysis-status').textContent = '오디오를 전사하고 있습니다…';
      input.window.samples = new Float32Array(input.window.samples);
      const audio = await prepareSttAudio(input.window, input.key);
      if (input.vadModelHash) {
        measurement = await run.vadClient.run('measure-speech', { audio, modelHash: input.vadModelHash });
      }
      input = { audio, modelId: input.modelId, modelHash: input.modelHash, device: input.device, dtype: input.dtype,
        language: input.language, backend: input.backend, locale: input.locale, preset: input.preset };
    } else $('analysis-status').textContent = message.operation === 'reconcile' ? '전체 원문과 구간별 후보를 대조해 통합하고 있습니다…' : message.operation === 'plan-summary' ? '전사를 모델의 입력 한도에 맞춰 나누고 있습니다…' : `구간 ${(input.partIndex ?? 0) + 1}/${input.totalParts ?? 1} · 원문 근거를 확인하며 요약하고 있습니다…`;
    if (run !== active || run.cancelled) return;
    let result = message.operation === 'transcribe' && input.backend === 'apple'
      ? await bridge.transcribeApple({ audio: input.audio, locale: input.locale, preset: input.preset })
      : await run.client.run(message.operation, input);
    if (message.operation === 'transcribe') result = markUnconfirmedSpeech(result, input.audio, measurement);
    await bridge.inferenceResult({ id: message.id, runId: run.id, result });
  } catch (error) {
    await bridge.inferenceResult({ id: message.id, runId: run.id, error: error.message,
      ...(['OUTPUT_LIMIT', 'CONTEXT_LIMIT'].includes(error.code) ? { errorCode: error.code } : {}) }).catch(() => {});
  }
});
export async function analyze(id, language = $('analysis-language').value) {
  if (active) return;
  preview.stop();
  completedRunId = undefined; $('analysis-export').hidden = true; $('export-status').textContent = '';
  $('review-status').textContent = '';
  $('correction-status').textContent = '';
  const run = active = { id: crypto.randomUUID(), client: new InferenceClient(), vadClient: new InferenceClient(), cancelled: false };
  $('analysis').hidden = false; $('analysis-cancel').hidden = false;
  $('analysis-status').textContent = '녹음의 무결성을 검증하고 있습니다…';
  $('transcript').replaceChildren(); $('summary').replaceChildren();
  pausesList.replaceChildren(); pausesPanel.hidden = true;
  try {
    const result = await bridge.analyze(id, run.id, language);
    if (run.cancelled) return;
    renderAnalysis(result);
    completedRunId = run.id; $('analysis-export').hidden = false;
    completedRecordId = id; completedLanguage = language;
  } catch (error) {
    $('analysis-status').textContent = run.cancelled ? '분석을 취소했습니다. 완료된 작업은 다시 사용할 수 있습니다.' : `분석을 완료하지 못했습니다: ${error.message}`;
  } finally {
    run.client.dispose(); run.vadClient.dispose(); active = undefined; $('analysis-cancel').hidden = true;
  }
}
$('analysis-cancel').addEventListener('click', async () => {
  const run = active; if (!run) return;
  run.cancelled = true; run.client.dispose(); run.vadClient.dispose();
  $('analysis-status').textContent = '분석을 취소하고 있습니다…';
  await bridge.cancelAnalysis(run.id).catch(() => {});
});

$('analysis-export').addEventListener('click', async () => {
  const runId = completedRunId;
  if (!runId) return;
  $('analysis-export').disabled = true;
  $('export-status').textContent = 'Markdown 파일을 저장하고 있습니다…';
  try {
    const saved = await bridge.exportAnalysis(runId);
    if (completedRunId === runId) $('export-status').textContent = `이 기기에 저장했습니다: ${saved.path}`;
  } catch (error) {
    if (completedRunId === runId) $('export-status').textContent = `저장하지 못했습니다: ${error.message}`;
  } finally { $('analysis-export').disabled = false; }
});

export function renderAnalysis(result) {
  preview.stop();
  $('analysis').dataset.revision = String(result.transcript.revision);
  $('transcript').replaceChildren(); $('summary').replaceChildren();
  pausesList.replaceChildren(); pausesPanel.hidden = !result.transcript.pauses?.length;
  for (const pause of result.transcript.pauses ?? []) {
    const item = document.createElement('li');
    item.textContent = `${pause.source === 'microphone' ? '마이크' : '공유 오디오'} · ${pause.start.toFixed(3)}${pause.end === null ? '초부터 재개 없이 녹음 종료' : `–${pause.end.toFixed(3)}초`}`;
    pausesList.append(item);
  }
    for (const segment of result.transcript.segments) {
      const li = document.createElement('li');
      const label = document.createElement('small');
      label.textContent = `${segment.source === 'microphone' ? '마이크' : '공유 오디오'} · ${segment.start.toFixed(1)}초`;
      if (segment.flags?.includes('speech-unconfirmed')) label.textContent += segment.speechReview === 'accepted'
        ? ' · 사용자 판단: 요약에 사용' : segment.speechReview === 'rejected' ? ' · 사용자 판단: 요약에서 제외' : ' · 발화 미확인: 원음 검토 필요';
      const text = document.createElement('p'); text.textContent = segment.rawText;
      li.append(label, text); $('transcript').append(li);
      if (segment.id && segment.end > segment.start) {
        const play = document.createElement('button'), status = document.createElement('small');
        play.className = 'secondary'; play.textContent = '원음 재생';
        status.setAttribute('role', 'status');
        let playing = false;
        play.addEventListener('click', async () => {
          if (playing) { preview.stop(); return; }
          const runId = completedRunId; if (!runId) return;
          status.textContent = '';
          try {
            await preview.play(() => bridge.transcriptAudio(runId, segment.id), state => {
              playing = state !== 'idle';
              play.textContent = state === 'loading' ? '불러오기 취소' : state === 'playing' ? '재생 중지' : '원음 재생';
              status.textContent = state === 'playing' ? ' 원음 재생 중' : state === 'loading' ? ' 원음을 확인하고 있습니다…' : '';
            });
          } catch (error) { status.textContent = ` 원음을 재생하지 못했습니다: ${error.message}`; }
        });
        li.append(play, status);
      }
      if (segment.originalRawText !== undefined) {
        const original = document.createElement('details'), title = document.createElement('summary'), raw = document.createElement('p');
        title.textContent = '모델 전사 원본 보기'; raw.textContent = segment.originalRawText; original.append(title, raw); li.append(original);
      }
      if (segment.flags?.includes('speech-unconfirmed') && result.transcript.baseHash) {
        const field = document.createElement('label'), select = document.createElement('select');
        field.className = 'language-label'; field.textContent = '원음을 확인한 뒤 판단하세요 ';
        select.setAttribute('aria-label', '전사 사용 판단'); select.className = 'speech-review-choice';
        for (const [value, text] of [['candidate', '검토 전 · 요약 보류'], ['accepted', '요약에 사용'], ['rejected', '요약에서 제외']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
        }
        select.value = segment.speechReview ?? 'candidate';
        select.addEventListener('change', async () => {
          const runId = completedRunId, recordId = completedRecordId, language = completedLanguage;
          if (!runId) return;
          preview.stop(); select.disabled = true;
          $('correction-status').textContent = '전사 판단을 저장하고 있습니다…';
          try {
            await bridge.reviewTranscript(runId, segment.id, select.value);
            if (completedRunId === runId) await analyze(recordId, language);
          } catch (error) {
            if (completedRunId === runId) {
              select.value = segment.speechReview ?? 'candidate';
              $('correction-status').textContent = `전사 판단을 저장하지 못했습니다: ${error.message}`;
            }
          } finally { select.disabled = false; }
        });
        field.append(select); li.append(field);
      }
      if (result.transcript.baseHash) {
        const editor = document.createElement('details'), title = document.createElement('summary'); title.textContent = '전사 수정';
        const input = document.createElement('textarea'); input.value = segment.rawText; input.maxLength = 12000; input.setAttribute('aria-label', '전사 문장 수정');
        const save = document.createElement('button'); save.className = 'secondary'; save.textContent = '수정 저장 후 재요약';
        save.addEventListener('click', async () => {
          const runId = completedRunId, recordId = completedRecordId, language = completedLanguage;
          if (!runId) return;
          preview.stop();
          save.disabled = true; $('correction-status').textContent = '수정본을 저장하고 있습니다…';
          try {
            const saved = await bridge.correctTranscript(runId, segment.id, input.value);
            if (completedRunId !== runId) return;
            if (saved.changed) await analyze(recordId, language);
            else $('correction-status').textContent = '변경된 내용이 없습니다.';
          } catch (error) {
            if (completedRunId === runId) $('correction-status').textContent = `수정본을 저장하지 못했습니다: ${error.message}`;
          } finally { save.disabled = false; }
        });
        editor.append(title, input, save); li.append(editor);
      }
    }
    const reconciled = result.reconciliation?.state === 'complete';
    const groups = summaryGroups(result);
    for (const [groupIndex, group] of groups.entries()) for (const [itemIndex, item] of group.summary.items.entries()) {
      const li = document.createElement('li');
      const label = document.createElement('small'); label.textContent = (reconciled ? '통합 · ' : result.summaryParts?.total > 1 ? '구간 ' + (group.index + 1) + '/' + result.summaryParts.total + ' · ' : '') + ({ action: '할 일', decision: '결정', topic: '논의' })[item.kind];
      const text = document.createElement('p'); text.textContent = item.text;
      li.append(label, text);
      for (const evidence of item.evidence) {
        const quote = document.createElement('blockquote'); quote.textContent = evidence.quote; li.append(quote);
      }
      if (result.reviews?.[groupIndex]?.[itemIndex]) {
        const field = document.createElement('label'); field.className = 'language-label'; field.textContent = '검토 상태';
        const select = document.createElement('select'); select.className = 'review-choice';
        for (const [value, text] of [['candidate', '검토 전'], ['accepted', '채택'], ['rejected', '제외']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
        }
        select.value = result.reviews[groupIndex][itemIndex];
        select.addEventListener('change', async () => {
          const runId = completedRunId, next = select.value;
          if (!runId) return;
          document.querySelectorAll('.review-choice').forEach(el => { el.disabled = true; });
          $('review-status').textContent = '검토 판단을 저장하고 있습니다…';
          try {
            const state = await bridge.reviewAnalysis(runId, groupIndex, itemIndex, next);
            if (completedRunId === runId) { result.reviews[groupIndex][itemIndex] = state; $('review-status').textContent = '검토 판단을 이 기기에 저장했습니다.'; }
          } catch (error) {
            if (completedRunId === runId) { select.value = result.reviews[groupIndex][itemIndex]; $('review-status').textContent = `검토 판단을 저장하지 못했습니다: ${error.message}`; }
          } finally { document.querySelectorAll('.review-choice').forEach(el => { el.disabled = false; }); }
        });
        field.append(select); li.append(field);
      }
      $('summary').append(li);
    }
    const summaryError = result.summaryErrorCode === 'CONTEXT_LIMIT' ? '모델 입력 한도를 넘었습니다. 보존된 전사를 검토하세요.' : result.summaryError;
    $('analysis-status').textContent = reconciled ? '전사·통합 요약 완료 · 변경·취소 내용을 원문과 비교해 검토하세요.' : result.reconciliation?.state === 'failed' ? `구간 요약은 보존됐지만 통합을 완료하지 못했습니다: ${summaryError}` : result.summaryParts?.state === 'partial' ? `구간 요약 ${result.summaryParts.parts.length}/${result.summaryParts.total} 완료 · 나머지는 재시도가 필요합니다: ${summaryError}` : result.summaryParts?.total > 1 ? `구간 요약 ${result.summaryParts.total}/${result.summaryParts.total} 완료 · 구간 사이의 결정 변경·취소는 원문 검토가 필요합니다.` : summaryError ? `전사는 완료됐지만 요약을 완료하지 못했습니다: ${summaryError}` : result.needsReview ? '발화 미확인 또는 전사 충돌·누락으로 요약을 보류했습니다. 원음을 검토하세요.' :
      result.summary ? '전사·요약 완료 · 요약 후보를 원문과 비교해 검토하세요.' :
      result.transcript.segments.length && result.transcript.segments.every(s => s.speechReview === 'rejected')
        ? '사용자 판단으로 모든 전사를 요약에서 제외했습니다. 원문은 보존됩니다.' : '전사 완료 · 요약할 발화가 없습니다.';
}
