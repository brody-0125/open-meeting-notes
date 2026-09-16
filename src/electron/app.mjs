import { app, BrowserWindow, protocol, ipcMain, session, dialog, desktopCapturer, powerMonitor } from 'electron';
import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { APP_URL, assertSender, isLocalResource } from './policy.mjs';
import { installCapturePermissions } from './permissions.mjs';
import { installWindowsDisplayPicker } from './display-picker.mjs';
import { Recording } from '../recording.mjs';
import { ChunkStore } from '../store.mjs';
import { sealRecording, inspectRecording } from '../recording-seal.mjs';
import { transcriptAudio } from '../transcript-audio.mjs';
import { RecordingLibrary } from '../library.mjs';
import { installedModels } from './installed-models.mjs';
import { analyzeRecording } from '../analyze-recording.mjs';
import { InferenceChannel } from './inference-channel.mjs';
import { saveMeetingMarkdown } from '../export.mjs';
import { exportRecoveredAudio } from '../recovery-export.mjs';
import { ReviewStore, reviewKeys, reviewStates, speechReviewKey } from '../reviews.mjs';
import { CorrectionStore } from '../corrections.mjs';

export function startApp({ directory, show = true, confirm, modelConfig, onBlockedRequest } = {}) {
  if (directory) app.setPath('userData', directory);
  // JobStore and review updates assume one Main owner per profile.
  if (!app.requestSingleInstanceLock()) { app.quit(); return Promise.resolve(); }
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!show || !window) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  });
  app.commandLine.appendSwitch('disable-background-networking');
  // Custom omn:// resources require no DNS. Reject Chromium resolver requests
  // before its network resolver; this does not govern Node's native sockets.
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ^NOTFOUND');
  protocol.registerSchemesAsPrivileged([{ scheme: 'omn', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  // Do not top-level await readiness in the Electron entry module.
  return app.whenReady().then(async () => {
    // Keep Chromium proxy-capable traffic on an owned loopback listener that
    // closes every connection without reading or forwarding its contents.
    const denyProxy = createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      denyProxy.once('error', reject); denyProxy.listen(0, '127.0.0.1', resolve);
    });
    try {
      await session.defaultSession.setProxy({ mode: 'fixed_servers',
        proxyRules: `http://127.0.0.1:${denyProxy.address().port}`, proxyBypassRules: '<-loopback>' });
      await session.defaultSession.closeAllConnections();
    } catch (error) { denyProxy.close(); throw error; }
    app.once('will-quit', () => denyProxy.close());
    const root = directory ?? app.getPath('userData');
    await mkdir(join(root, 'recordings'), { recursive: true });
    const files = new Map([
      ['/index.html', new URL('../ui/index.html', import.meta.url)],
      ['/app.css', new URL('../ui/app.css', import.meta.url)],
      ['/app.mjs', new URL('../ui/app.mjs', import.meta.url)],
      ['/analysis.mjs', new URL('../ui/analysis.mjs', import.meta.url)],
      ['/preview.mjs', new URL('../audio/preview.mjs', import.meta.url)],
      ['/summary-groups.mjs', new URL('../summary-groups.mjs', import.meta.url)],
      ['/silence-ui.mjs', new URL('../ui/silence.mjs', import.meta.url)],
      ['/inference-client.mjs', new URL('../inference/client.mjs', import.meta.url)],
      ['/inference-worker.mjs', new URL('../inference/worker.mjs', import.meta.url)],
      ['/model-location.mjs', new URL('../inference/model-location.mjs', import.meta.url)]
    ]);
    for (const name of ['vad-capture', 'vad-worklet', 'silence', 'silence-monitor', 'acquire-inputs',
      'capture-device', 'capture-drain', 'capture-worklet', 'pcm', 'resample', 'speech-evidence'])
      files.set(`/${name}.mjs`, new URL(`../audio/${name}.mjs`, import.meta.url));
    let models = { stt: null, summary: null, vad: null, error: null };
    try {
      if (modelConfig === undefined) {
        try { modelConfig = JSON.parse(await readFile(new URL('../../models/installed.json', import.meta.url), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const installed = await installedModels(modelConfig, { baseDirectory: fileURLToPath(new URL('../../models/', import.meta.url)) });
      const bundles = [];
      for (const [kind, name] of [['stt', 'whisper'], ['summary', 'summarizer'], ['vad', 'silero']]) if (installed.status[kind]) {
        const path = new URL(`../../dist/${name}.js`, import.meta.url);
        await access(path); bundles.push([`/${name}.mjs`, path]);
      }
      for (const [route, path] of [...installed.files, ...bundles]) files.set(route, path);
      models = { ...installed.status, error: null };
    } catch (error) {
      console.error('Local model installation rejected:', error.message);
      models.error = '설치된 모델을 검증하지 못했습니다. 모델팩과 앱 빌드를 확인하세요.';
    }
    protocol.handle('omn', async request => {
      const url = new URL(request.url), file = isLocalResource(request.url) && files.get(url.pathname);
      if (!file || request.method !== 'GET') return new Response('denied', { status: 403 });
      let bytes;
      try { bytes = typeof file === 'function' ? await file() : await readFile(file); }
      catch { return new Response('local resource verification failed', { status: 500 }); }
      return new Response(bytes, { headers: {
        'content-type': url.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.wasm') ? 'application/wasm' : url.pathname.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream',
        'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'"
      } });
    });
    session.defaultSession.webRequest.onBeforeRequest((details, done) => {
      const cancel = !isLocalResource(details.url);
      if (cancel) onBlockedRequest?.();
      done({ cancel });
    });
    const window = new BrowserWindow({ width: 1060, height: 780, minWidth: 380, minHeight: 600, show,
      title: 'open-meeting-notes', backgroundColor: '#ffffff', webPreferences: {
        preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true,
        contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false
      } });
    window.setMenuBarVisibility(false);
    // webRequest/CSP do not cover direct WebRTC UDP. This policy is not a
    // complete egress firewall; the deny proxy separately covers TURN/TCP.
    window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    const gate = installCapturePermissions(session.defaultSession, window);
    installWindowsDisplayPicker({ session: session.defaultSession, window, gate, desktopCapturer, dialog });
    let recording, id, cutoffs, preparing = false, finalizing = false;
    const isRecordingActive = () => ['recording', 'pausing', 'paused', 'resuming', 'draining'].includes(recording?.state);
    let suspensionGeneration = 0;
    const library = new RecordingLibrary(join(root, 'recordings'));
    let inspecting = false, previewing = false;
    let analysis, lastAnalysis, exporting = false, reviewing = false;
    const analysisUnavailable = runId => reviewing || exporting || analysis || !lastAnalysis || runId !== lastAnalysis.runId;
    powerMonitor.on('suspend', () => {
      suspensionGeneration++;
      window.webContents.send('meeting:stop-playback');
      gate.revoke();
      analysis?.controller.abort();
      if (isRecordingActive()) {
        recording.abort('시스템 절전으로 녹음이 중단됐습니다. 다시 녹음하려면 새로 승인해 주세요.');
        window.webContents.send('meeting:request-stop');
      }
    });
    const channel = new InferenceChannel(message => window.webContents.send('meeting:inference-request', { ...message, runId: analysis.runId }));
    const handle = (name, fn) => ipcMain.handle(`meeting:${name}`, (event, ...args) => { assertSender(event, window); return fn(event, ...args); });
    const current = sessionId => { if (!recording || sessionId !== id) throw new Error('stale recording session'); return recording; };
    handle('models', () => models);
    handle('transcript-audio', async (_event, runId, segmentId) => {
      if (previewing || analysis || preparing || finalizing || isRecordingActive() || !lastAnalysis || runId !== lastAnalysis.runId)
        throw new Error('audio preview unavailable or stale');
      const snapshot = lastAnalysis, generation = suspensionGeneration;
      const segment = snapshot.result.transcript.segments.find(s => s.id === segmentId);
      if (!segment) throw new Error('unknown transcript segment');
      previewing = true;
      try {
        const { path } = await library.directory(snapshot.selectedId);
        const recording = await inspectRecording(path);
        if (recording.state !== 'complete' || recording.sessionId !== snapshot.selectedId) throw new Error('complete recording required for preview');
        const result = await transcriptAudio(new ChunkStore(path), recording.index, snapshot.selectedId, segment, { pauses: recording.pauses ?? [] });
        if (lastAnalysis !== snapshot || analysis || preparing || isRecordingActive() || generation !== suspensionGeneration)
          throw new Error('audio preview became stale');
        return result;
      } finally { previewing = false; }
    });
    handle('analyze', async (_event, selectedId, runId, language) => {
      if (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('invalid analysis request');
      if (analysis || exporting || reviewing || preparing || finalizing || isRecordingActive()) throw new Error('recording or analysis is busy');
      const controller = new AbortController();
      lastAnalysis = undefined;
      const active = analysis = { runId, controller };
      try {
        const { path } = await library.directory(selectedId);
        const result = await analyzeRecording({ root: path, models, language, signal: controller.signal,
          execute: (operation, input) => channel.request(operation, input, controller.signal) });
        controller.signal.throwIfAborted();
        const keys = reviewKeys(result, models.summary.modelHash), reviews = new ReviewStore(join(path, 'reviews'));
        result.reviews = [];
        for (const row of keys) result.reviews.push(await Promise.all(row.map(key => reviews.get(key))));
        controller.signal.throwIfAborted();
        lastAnalysis = { runId, selectedId, result, keys, reviews, corrections: new CorrectionStore(join(path, 'corrections')),
          speechReviews: new ReviewStore(join(path, 'speech-reviews')) };
        return result;
      } finally { if (analysis === active) analysis = undefined; }
    });
    handle('export-analysis', async (_event, runId) => {
      if (analysisUnavailable(runId)) throw new Error('analysis export unavailable or stale');
      const snapshot = lastAnalysis;
      exporting = true;
      try { return await saveMeetingMarkdown(join(root, 'exports'), snapshot.selectedId, snapshot.result); }
      finally { exporting = false; }
    });
    handle('review-analysis', async (_event, runId, group, item, state) => {
      if (analysisUnavailable(runId) ||
          !Number.isSafeInteger(group) || group < 0 || !Number.isSafeInteger(item) || item < 0 ||
          !lastAnalysis.keys[group]?.[item] || !reviewStates.includes(state)) throw new Error('invalid or stale review request');
      const snapshot = lastAnalysis;
      reviewing = true;
      try {
        await snapshot.reviews.set(snapshot.keys[group][item], state);
        snapshot.result.reviews[group][item] = state;
        return state;
      } finally { reviewing = false; }
    });
    handle('cancel-analysis', (_event, runId) => { if (analysis?.runId === runId) analysis.controller.abort(); });
    handle('correct-transcript', async (_event, runId, segmentId, text) => {
      if (analysisUnavailable(runId)) throw new Error('invalid or stale correction request');
      const snapshot = lastAnalysis;
      reviewing = true;
      try {
        const transcript = await snapshot.corrections.save(snapshot.result.transcript, segmentId, text);
        const changed = transcript.revision !== snapshot.result.transcript.revision;
        if (changed) lastAnalysis = undefined; // Old summaries/reviews/export are no longer current.
        return { changed, revision: transcript.revision };
      } finally { reviewing = false; }
    });
    handle('review-transcript', async (_event, runId, segmentId, state) => {
      if (analysisUnavailable(runId) || !reviewStates.includes(state))
        throw new Error('invalid or stale speech review');
      const snapshot = lastAnalysis, transcript = snapshot.result.transcript;
      const segment = transcript.segments.find(s => s.id === segmentId);
      if (!segment) throw new Error('unknown transcript segment');
      const key = speechReviewKey(transcript, segment);
      reviewing = true;
      try {
        await snapshot.speechReviews.set(key, state);
        lastAnalysis = undefined;
        return state;
      } finally { reviewing = false; }
    });
    handle('inference-result', (_event, message) => Boolean(analysis && message?.runId === analysis.runId && channel.respond(message)));
    handle('list', async () => (await library.list()).filter(entry => !(entry.id === id && (finalizing || isRecordingActive()))));
    handle('inspect', async (_event, selectedId) => {
      if (inspecting || selectedId === id && (finalizing || isRecordingActive())) throw new Error('recording is busy');
      inspecting = true;
      try { return await library.inspect(selectedId); } finally { inspecting = false; }
    });
    handle('prepare', async event => {
      window.webContents.send('meeting:stop-playback');
      if (analysis || exporting || preparing || finalizing || isRecordingActive()) throw new Error('recording or analysis already active');
      preparing = true;
      const requestedGeneration = suspensionGeneration;
      try {
        const approved = confirm ? await confirm() : (await dialog.showMessageBox(window, {
          type: 'question', title: '녹음 승인', message: '이 회의의 오디오를 녹음할까요?',
          detail: '마이크와 컴퓨터에서 재생되는 소리를 이 기기에 저장합니다. 회의 참가자에게 녹음 사실을 알려주세요.',
          buttons: ['취소', '녹음 준비'], defaultId: 0, cancelId: 0, noLink: true
        })).response === 1;
        if (!approved || requestedGeneration !== suspensionGeneration) return null;
        assertSender(event, window);
        id = randomUUID();
        cutoffs = undefined;
        recording = new Recording(id, new ChunkStore(join(root, 'recordings', id)));
        recording.start(recording.requestConsent());
        gate.arm(event);
        return { id };
      } finally { preparing = false; }
    });
    handle('recover-audio', async (_event, selectedId) => {
      if (exporting || reviewing || analysis || preparing || finalizing || isRecordingActive()) throw new Error('recording or export is busy');
      exporting = true;
      try {
        const { path } = await library.directory(selectedId);
        return await exportRecoveredAudio({ root: path, directory: join(root, 'exports'), sessionId: selectedId });
      } finally { exporting = false; }
    });
    handle('acquired', (_event, sessionId) => { current(sessionId); gate.revoke(); });
    handle('append', (_event, sessionId, { meta, pcm }) => current(sessionId).append(meta, new Uint8Array(pcm)));
    handle('pause', (_event, sessionId, record) => current(sessionId).pause(record));
    handle('resume', (_event, sessionId, record) => current(sessionId).resume(record));
    handle('stop', (_event, sessionId, value) => { current(sessionId).stop(value); cutoffs = { ...value }; gate.revoke(); });
    handle('finish', async (_event, sessionId) => {
      if (finalizing) throw new Error('recording is being finalized');
      const r = current(sessionId);
      finalizing = true;
      try {
        await r.finish();
        await sealRecording({ store: r.store, sessionId, cutoffs });
        return { id: sessionId, state: r.state };
      } finally { finalizing = false; }
    });
    handle('abort', (_event, sessionId, reason) => { current(sessionId).abort(reason); gate.revoke(); });
    window.webContents.on('render-process-gone', () => {
      lastAnalysis = undefined;
      analysis?.controller.abort();
      if (isRecordingActive()) recording.abort('renderer terminated');
    });
    window.on('close', event => {
      analysis?.controller.abort();
      if (finalizing || isRecordingActive()) {
        event.preventDefault(); window.webContents.send('meeting:request-stop');
      }
    });
    app.on('window-all-closed', () => app.quit());
    await window.loadURL(APP_URL);
    return window;
  });
}
