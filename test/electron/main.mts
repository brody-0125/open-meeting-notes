// Integration harness only: no microphone, screen capture, production consent
// or product UI. Loads production Worklet and storage via a sandboxed renderer.
import { app, BrowserWindow, protocol, ipcMain, session } from 'electron';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Recording } from '../../src/recording.mjs';
import { ChunkStore } from '../../src/store.mjs';
import { APP_URL, assertSender, isLocalResource } from '../../src/electron/policy.mjs';
import { verifyModelPack } from '../../src/model-pack.mjs';
import { join } from 'node:path';
import { installCapturePermissions } from '../../src/electron/permissions.mjs';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setPath('userData', process.env.OMN_TEST_PROFILE);
protocol.registerSchemesAsPrivileged([{ scheme: 'omn', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.whenReady().then(async () => {
const files = new Map([
  ['/vad-capture.mjs', new URL('../../src/audio/vad-capture.mjs', import.meta.url)],
  ['/vad-worklet.mjs', new URL('../../src/audio/vad-worklet.mjs', import.meta.url)],
  ['/model-location.mjs', new URL('../../src/inference/model-location.mjs', import.meta.url)],
  ['/capture-device.mjs', new URL('../../src/audio/capture-device.mjs', import.meta.url)],
  ['/capture-drain.mjs', new URL('../../src/audio/capture-drain.mjs', import.meta.url)],
  ['/silence.mjs', new URL('../../src/audio/silence.mjs', import.meta.url)],
  ['/resample.mjs', new URL('../../src/audio/resample.mjs', import.meta.url)],
  ['/inference-client.mjs', new URL('../../src/inference/client.mjs', import.meta.url)],
  ['/inference-worker.mjs', new URL('../../src/inference/worker.mjs', import.meta.url)],
  ['/index.html', new URL('./index.html', import.meta.url)],
  ['/capture-worklet.mjs', new URL('../../src/audio/capture-worklet.mjs', import.meta.url)],
  ['/pcm.mjs', new URL('../../src/audio/pcm.mjs', import.meta.url)]
]);
for (const [variable, engine, engineVersion, bundle] of [
  ['OMN_STT_FIXTURE', 'transformers', '4.3.0', 'whisper'],
  ['OMN_VAD_FIXTURE', 'silero', '1.31.0-dev.20260914-8d85527a0', 'silero'],
  ['OMN_SUMMARY_FIXTURE', 'webllm', '0.2.85', 'summarizer']
]) {
  const root = process.env[variable];
  if (!root) continue;
  const approval = JSON.parse(await readFile(join(root, 'fixture-approval.json'), 'utf8'));
  const pack = await verifyModelPack({ root, approvedManifestHash: approval.manifestHash, engine, engineVersion });
  for (const file of pack.files) files.set(`/${file.path}`, join(root, file.path));
  files.set(`/${bundle}.mjs`, engine === 'webllm'
    ? process.env.OMN_SUMMARY_BUNDLE ?? join(root, 'summarizer.mjs')
    : new URL(`../../dist/${bundle}.js`, import.meta.url));
  if (engine === 'transformers') files.set('/speech.wav', join(root, 'speech.wav'));
  if (engine === 'silero') for (const file of pack.files) files.set(`/packs/${pack.manifestHash}/${file.path}`, join(root, file.path));
}
protocol.handle('omn', async request => {
  const url = new URL(request.url);
  const file = isLocalResource(request.url) && files.get(url.pathname);
  if (!file || request.method !== 'GET') return new Response('denied', { status: 403 });
  return new Response(await readFile(file), { headers: {
    'content-type': url.pathname.endsWith('.html') ? 'text/html' : url.pathname.endsWith('.wasm') ? 'application/wasm' : url.pathname.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream',
    'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; style-src 'none'"
  } });
});
session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !isLocalResource(details.url) }));
const window = new BrowserWindow({ show: false, webPreferences: {
  preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
  sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
} });
// Never arm in synthetic capture tests: real device access stays denied.
installCapturePermissions(session.defaultSession, window);
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', event => event.preventDefault());
const store = new ChunkStore(process.env.OMN_TEST_AUDIO);
const recording = new Recording('browser-test', store);
function handle(channel, fn) { ipcMain.handle(channel, (event, ...args) => { assertSender(event, window); return fn(...args); }); }
handle('start', () => recording.start(recording.requestConsent()));
handle('append', ({ meta, pcm }) => recording.append(meta, new Uint8Array(pcm)));
handle('stop', cutoffs => recording.stop(cutoffs));
handle('pause', record => recording.pause(record));
handle('resume', record => recording.resume(record));
handle('abort', reason => recording.abort(reason));
handle('finish', async () => { await recording.finish(); return recording.state; });
await window.loadURL(APP_URL);
}).catch(error => { console.error(error); app.exit(1); });
