import { acquireInputs } from '/acquire-inputs.mjs';
import { prepareCapture } from '/capture-device.mjs';
import { analyze } from '/analysis.mjs';
import { startSilence } from '/silence-ui.mjs';
const $ = id => document.getElementById(id);
const bridge = window.meeting;
let phase = 'idle', session, capture, cancellation, interval, started, generation = 0;
let silence, installedVad, restartSilence, timeline = [];
function view(state, title, button, message, disabled = false) {
  phase = state; document.body.dataset.state = state;
  if (state !== 'recording') updateLevels(null);
  $('state').textContent = title; $('primary').textContent = button;
  $('primary').disabled = disabled; $('message').textContent = message;
  $('cancel').hidden = !['ready', 'acquiring', 'starting', 'preflight'].includes(state);
  $('pause').hidden = !['recording', 'pausing', 'paused', 'resuming'].includes(state);
  $('pause').disabled = !['recording', 'paused'].includes(state);
  $('pause').textContent = state === 'paused' ? '녹음 재개' : state === 'pausing' ? '정지 중' : state === 'resuming' ? '재개 중' : '일시정지';
  $('silence-enabled').disabled = !installedVad || !['idle', 'saved', 'failed', 'ready'].includes(state);
}
function stopClock() { clearInterval(interval); }
function resetTimeline() {
  timeline = [];
  $('timeline').hidden = true;
}
function height(rms) { return rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)) : 0; }
function drawTimeline() {
  const canvas = $('timeline-canvas'), cssW = canvas.clientWidth, cssH = 92, dpr = Math.max(1, devicePixelRatio || 1);
  if (!cssW) return;
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr); canvas.height = Math.floor(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const lane = (cssH - 6) / 2, col = 3, slice = timeline.slice(-(Math.floor(cssW / col) || 1));
  const x0 = cssW - slice.length * col;
  for (let i = 0; i < slice.length; i++) {
    const s = slice[i], x = x0 + i * col;
    if (s.paused) { ctx.fillStyle = '#c9d4cf'; ctx.fillRect(x + 1, 6, 1, cssH - 12); continue; }
    ctx.fillStyle = '#176952';
    const h1 = Math.max(2, s.mic * (lane - 8));
    ctx.fillRect(x, 3 + (lane - h1) / 2, col - 1, h1);
    ctx.fillStyle = '#3d7ea6';
    const h2 = Math.max(2, s.remote * (lane - 8));
    ctx.fillRect(x, lane + 3 + (lane - h2) / 2, col - 1, h2);
  }
  ctx.fillStyle = '#be493f';
  ctx.fillRect(cssW - 2, 4, 2, cssH - 8);
}
function appendTimeline(levels, paused) {
  timeline.push({ mic: paused ? 0 : height(levels?.microphone), remote: paused ? 0 : height(levels?.remote), paused: Boolean(paused) });
  if (timeline.length > 2400) timeline = timeline.slice(-2400);
  $('timeline').hidden = false;
  if ($('timeline-canvas').clientWidth) drawTimeline();
  else requestAnimationFrame(drawTimeline);
}
function updateLevels(levels) {
  for (const source of ['microphone', 'remote']) {
    const meter = $(`${source}-level`), rms = levels?.[source];
    const db = rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
    meter.value = db;
    meter.setAttribute('aria-valuetext', rms === undefined ? '측정 안 함' : rms === 0 ? '신호 없음' : `${db.toFixed(0)} dBFS`);
    $(`${source}-level-text`).textContent = rms === undefined ? '측정 안 함' : rms === 0 ? '신호 없음' : `${db.toFixed(0)} dBFS`;
  }
  if (phase === 'paused' || phase === 'pausing') appendTimeline(null, true);
  else if (levels && (phase === 'preflight' || phase === 'recording' || phase === 'resuming')) appendTimeline(levels, false);
}
async function fail(error, expected = generation) {
  if (expected !== generation) return;
  stopClock();
  silence?.stop(); silence = undefined; $('silence-extend').hidden = true;
  // Show the failure even when Main is the component that stopped responding.
  if (session) void bridge.abort(session.id, String(error.message ?? error).slice(0, 900)).catch(() => {});
  if (expected !== generation) return;
  if (error.code === 'FINALIZATION_TIMEOUT') {
    view('failed', '저장 결과를 확인해 주세요', '새 녹음 준비', '저장 확인 시간이 초과되었습니다. 잠시 후 기록 목록을 새로고침하고 오디오 검증을 실행하세요.');
    return;
  }
  view('failed', '녹음이 완료되지 않았습니다', '새 녹음 준비', error.message ?? String(error));
}
async function stop() {
  if (['ready', 'acquiring', 'starting', 'preflight'].includes(phase)) {
    ++generation;
    stopClock();
    view('cancelling', '준비 취소 중', '취소 중', '입력과 녹음 준비를 해제하고 있습니다.', true);
    cancellation?.abort();
    if (capture) await capture.abort('user cancelled preparation').catch(() => {});
    await bridge.abort(session.id, 'user cancelled preparation').catch(() => {}); session = undefined;
    resetTimeline();
    view('idle', '녹음 대기', '녹음 준비', '녹음 준비를 취소했습니다.'); return;
  }
  if (!['recording', 'pausing', 'paused', 'resuming'].includes(phase)) return;
  silence?.stop(); silence = undefined; $('silence-extend').hidden = true;
  $('silence-status').textContent = '무음 감시를 종료했습니다.';
  view('draining', '녹음을 저장하고 있습니다', '저장 중', '마지막 오디오의 저장을 확인하고 있습니다.', true);
  stopClock();
  try {
    await capture.stop();
    $('saved').textContent = `저장된 기록: ${session.id}`; $('saved').hidden = false;
    view('saved', '녹음 저장 완료', '새 녹음 준비', '두 입력의 오디오를 이 기기에 저장했습니다.');
    await refreshRecords();
    const saved = lastRecords.find(record => record.id === session.id);
    if (saved) selectRecord(saved);
  } catch (error) { await fail(error); }
}
$('primary').addEventListener('click', async () => {
  let actionGeneration = generation;
  try {
    if (['idle', 'saved', 'failed'].includes(phase)) {
      view('preparing', '녹음 승인 대기', '승인 대기', '승인 창에서 진행 여부를 선택하세요.', true);
      capture = undefined; restartSilence = undefined; $('saved').hidden = true; $('timer').textContent = '00:00';
      $('silence-status').textContent = '';
      resetTimeline();
      session = await bridge.prepare();
      if (!session) { view('idle', '녹음 대기', '녹음 준비', '녹음 준비를 취소했습니다.'); return; }
      view('ready', '입력을 선택해 주세요', '입력 선택 및 확인', '공유 오디오와 마이크를 선택한 뒤 음량을 확인하세요.');
    } else if (phase === 'ready') {
      const run = ++generation, id = session.id;
      actionGeneration = run;
      cancellation = new AbortController();
      // Must execute in this click before the first await to retain user activation.
      const pending = acquireInputs({ approved: true, signal: cancellation.signal });
      view('acquiring', '입력 선택 중', '선택 대기', '화면 공유에서 오디오를 포함하고 마이크 접근을 허용하세요.', true);
      const streams = await pending;
      if (run !== generation) { for (const stream of Object.values(streams)) for (const track of stream.getTracks()) track.stop(); return; }
      view('starting', '입력 연결 중', '연결 대기', '오디오 입력을 연결하고 있습니다.', true);
      const sink = { append: chunk => bridge.append(id, chunk), pause: record => bridge.pause(id, record), resume: record => bridge.resume(id, record),
        stop: cutoffs => bridge.stop(id, cutoffs), finish: () => bridge.finish(id), abort: reason => bridge.abort(id, reason) };
      const device = await prepareCapture({ context: new AudioContext({ sampleRate: 48000 }), streams, sessionId: id, sink });
      if (run !== generation) { await device.abort('cancelled during setup').catch(() => {}); return; }
      capture = device;
      capture.done.catch(error => { if (run === generation && phase !== 'draining') void fail(error, run); });
      await bridge.acquired(id);
      if (run !== generation) return;
      restartSilence = () => {
      if ($('silence-enabled').checked && installedVad) silence = startSilence({ streams, modelHash: installedVad.modelHash,
        onState: (state, now) => {
          if (run !== generation || phase !== 'recording') return;
          $('silence-extend').hidden = state.type !== 'warning';
          $('silence-status').textContent = state.type === 'warning' ? `두 입력에서 3분간 발화가 감지되지 않았습니다. ${Math.max(0, Math.ceil((state.deadline - now) / 1000))}초 후 녹음을 종료합니다.` :
            state.type === 'loading' ? '무음 감시 모델을 준비하고 있습니다. 녹음은 계속됩니다.' :
            state.type === 'failed' ? '무음 감시 오류로 자동 종료를 해제했습니다. 녹음은 계속됩니다. 직접 종료해 주세요.' :
            state.type === 'disabled' ? '최근 음성 관측을 확인할 수 없어 자동 종료를 보류합니다.' : '무음 감시 중 · 발화가 재개되면 종료 예고를 취소합니다.';
        }, onStop: () => { if (run === generation && phase === 'recording') void stop().catch(fail); }
      });
      };
      await device.preflight();
      if (run !== generation) { await device.abort('cancelled during preflight').catch(() => {}); return; }
      view('preflight', '입력 확인 중', '녹음 시작', '지금은 저장하지 않습니다. 말하거나 회의 소리를 재생해 두 음량계를 확인한 뒤 녹음 시작을 누르세요.');
      interval = setInterval(() => updateLevels(device.levels()), 250);
    } else if (phase === 'preflight') {
      const run = generation, device = capture;
      stopClock();
      view('starting', '녹음 시작 중', '시작 대기', '녹음을 시작하고 있습니다.', true);
      await device.start();
      if (run !== generation) { await device.abort('cancelled during start').catch(() => {}); return; }
      started = performance.now();
      interval = setInterval(() => {
        updateLevels(device.levels());
        const seconds = Math.floor((performance.now() - started) / 1000);
        $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      }, 250);
      view('recording', '녹음 중', '녹음 종료', '마이크와 공유 오디오를 녹음하고 있습니다.');
      restartSilence?.();
    } else if (['recording', 'pausing', 'paused', 'resuming'].includes(phase)) await stop();
  } catch (error) { if (error.name !== 'AbortError') await fail(error, actionGeneration); }
});
$('pause').addEventListener('click', async () => {
  if (!['recording', 'paused'].includes(phase)) return;
  const run = generation, pausing = phase === 'recording', expected = pausing ? 'pausing' : 'resuming';
  silence?.stop(); silence = undefined; $('silence-extend').hidden = true;
  $('silence-status').textContent = '일시정지 중에는 무음 자동 종료를 감시하지 않습니다.';
  view(expected, pausing ? '일시정지 처리 중' : '녹음 재개 중', '녹음 종료',
    pausing ? '마지막 오디오와 정지 경계를 저장하고 있습니다.' : '재개 경계를 저장하고 있습니다.');
  try {
    await (pausing ? capture.pause() : capture.resume());
    if (run !== generation || phase !== expected) return;
    if (pausing) view('paused', '녹음 일시정지', '녹음 종료', '지금의 음성은 저장하지 않습니다. 경과 시간에는 정지 시간이 포함됩니다.');
    else {
      view('recording', '녹음 중', '녹음 종료', '마이크와 공유 오디오를 녹음하고 있습니다.');
      $('silence-status').textContent = ''; restartSilence?.();
    }
  } catch (error) { if (run === generation && phase === expected) await fail(error, run); }
});
$('cancel').addEventListener('click', () => { void stop().catch(fail); });
bridge.onStopRequested(() => { void stop().catch(fail); });
$('silence-extend').addEventListener('click', () => silence?.extend());

let loadingRecords = false, selectedRecordId, lastRecords = [], inspectHints = new Map();
function inspectHintText(entry) {
  if (!entry) return '선택하여 상세 보기';
  if (entry.hint) return entry.hint;
  if (entry.kind === 'recover') return entry.text.slice(0, 48);
  return entry.text;
}
function applyDetailInspect(entry) {
  $('detail-status').textContent = entry?.text ?? '검증 전';
  $('detail-recover').hidden = !entry || entry.state === 'complete';
}
function selectRecord(record) {
  selectedRecordId = record.id;
  $('record-detail').hidden = false;
  $('detail-date').textContent = new Date(record.modifiedAt).toLocaleString('ko-KR');
  $('detail-id').textContent = record.id;
  applyDetailInspect(inspectHints.get(record.id));
  dispatchEvent(new CustomEvent('omn-select-record', { detail: record.id }));
}
function updateAnalysisButtons(models) {
  $('detail-transcribe').hidden = !models.stt;
  const both = models.stt && models.summary;
  $('detail-summarize').hidden = !both;
  $('detail-analyze').hidden = !both;
}
async function inspectSelected() {
  if (!selectedRecordId) return;
  $('detail-verify').disabled = true;
  $('detail-status').textContent = '오디오를 확인하고 있습니다…';
  try {
    const result = await bridge.inspect(selectedRecordId);
    const text = result.state === 'complete' ? `완료 확인 · ${result.durationSeconds.toFixed(1)}초` :
      result.state === 'incomplete' ? '미완료 기록 · 복구 검토가 필요합니다.' : '손상 감지 · 오디오를 확인해 주세요.';
    inspectHints.set(selectedRecordId, { text, state: result.state,
      hint: result.state === 'complete' ? `${result.durationSeconds.toFixed(1)}초` : undefined });
    applyDetailInspect(inspectHints.get(selectedRecordId));
    const hint = document.querySelector(`.record-picker[data-record-id="${selectedRecordId}"] .record-hint`);
    if (hint) hint.textContent = inspectHintText(inspectHints.get(selectedRecordId));
  } catch { $('detail-status').textContent = '지금은 검증할 수 없습니다. 녹음 종료 후 다시 시도하세요.'; }
  finally { $('detail-verify').disabled = false; }
}
async function recoverSelected() {
  if (!selectedRecordId) return;
  $('detail-recover').disabled = true; $('detail-verify').disabled = true;
  $('detail-status').textContent = '검증된 구간을 별도 WAV로 저장하고 있습니다. 원본은 변경하지 않습니다.';
  try {
    const result = await bridge.recoverAudio(selectedRecordId);
    const text = `누락 구간은 복원되지 않습니다. ${result.spans}개 구간 · 복구 오디오 저장: ${result.path}`;
    inspectHints.set(selectedRecordId, { text, kind: 'recover', state: 'incomplete' });
    applyDetailInspect(inspectHints.get(selectedRecordId));
    const hint = document.querySelector(`.record-picker[data-record-id="${selectedRecordId}"] .record-hint`);
    if (hint) hint.textContent = inspectHintText(inspectHints.get(selectedRecordId));
  } catch (error) { $('detail-status').textContent = `복구 오디오를 저장하지 못했습니다: ${error.message}`; }
  finally { $('detail-recover').disabled = false; $('detail-verify').disabled = false; }
}
async function runAnalysis(mode) {
  if (!selectedRecordId) return;
  for (const id of ['detail-transcribe', 'detail-summarize', 'detail-analyze']) $(id).disabled = true;
  try { await analyze(selectedRecordId, $('analysis-language').value, mode); }
  finally { for (const id of ['detail-transcribe', 'detail-summarize', 'detail-analyze']) $(id).disabled = false; }
}
$('detail-verify').addEventListener('click', () => { void inspectSelected(); });
$('detail-recover').addEventListener('click', () => { void recoverSelected(); });
$('detail-transcribe').addEventListener('click', () => { void runAnalysis('transcribe'); });
$('detail-summarize').addEventListener('click', () => { void runAnalysis('summarize'); });
$('detail-analyze').addEventListener('click', () => { void runAnalysis('full'); });
async function refreshRecords() {
  if (loadingRecords) return;
  loadingRecords = true;
  $('refresh').disabled = true;
  try {
    const records = await bridge.list();
    lastRecords = records;
    const models = await bridge.models();
    installedVad = models.vad;
    updateAnalysisButtons(models);
    $('silence-enabled').disabled = !installedVad || !['idle', 'saved', 'failed', 'ready'].includes(phase);
    $('silence-model').textContent = installedVad ? '로컬 무음 감시 모델 설치됨' : '무음 자동 종료에는 승인된 로컬 VAD 모델이 필요합니다.';
    const sttLabel = models.stt?.label ?? (models.stt?.backend === 'apple' ? `macOS 음성 인식 (${models.stt.locale})` : models.stt?.modelId ? `로컬 Whisper (${models.stt.modelId})` : null);
    $('model-status').textContent = models.error ?? (models.stt && models.summary ? `${sttLabel ?? '전사'} · 요약 설치됨${models.vad ? ' · 발화 감지 설치됨' : ' · 발화 감지 미설치: 자동 요약 보류'}` : '전사·요약을 실행하려면 승인된 로컬 모델팩을 설치하세요.');
    $('records').replaceChildren();
    $('library-message').textContent = records.length ? '최근 50개까지 표시합니다. 항목을 선택하세요.' : '저장된 기록이 없습니다.';
    for (const record of records) {
      const row = document.createElement('li');
      const picker = document.createElement('button');
      picker.type = 'button';
      picker.className = 'record-picker secondary';
      picker.dataset.recordId = record.id;
      const title = document.createElement('strong');
      title.textContent = new Date(record.modifiedAt).toLocaleString('ko-KR');
      const hint = document.createElement('span');
      hint.className = 'record-hint';
      hint.textContent = inspectHintText(inspectHints.get(record.id));
      picker.append(title, hint);
      picker.addEventListener('click', () => selectRecord(record));
      if (record.id === selectedRecordId) picker.classList.add('selected');
      row.append(picker); $('records').append(row);
    }
    if (selectedRecordId) {
      const current = records.find(record => record.id === selectedRecordId);
      if (current) selectRecord(current);
      else { selectedRecordId = undefined; $('record-detail').hidden = true; }
    } else if (records.length === 1) selectRecord(records[0]);
  } catch { $('library-message').textContent = '기록 목록을 불러오지 못했습니다. 다시 시도하세요.'; }
  finally { loadingRecords = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', () => { void refreshRecords(); });
addEventListener('resize', () => { if (!$('timeline').hidden) drawTimeline(); });
void refreshRecords();
