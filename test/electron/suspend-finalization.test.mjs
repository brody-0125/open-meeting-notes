import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { inspectRecording } from '../../src/recording-seal.mjs';
import { ChunkStore } from '../../src/store.mjs';

for (const stage of ['draining', 'sealing']) test(`suspend during ${stage} respects the audio completion boundary`, { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omn-suspend-finish-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {});
    await app.close(); await rm(directory, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  // Pause a real store operation in Main, without adding production test hooks.
  await app.evaluate((_, stage) => {
    const ChunkStore = globalThis.testChunkStore;
    const method = stage === 'draining' ? 'put' : 'index';
    const original = ChunkStore.prototype[method];
    globalThis.checkpoint = false;
    ChunkStore.prototype[method] = async function (...args) {
      const result = await original.apply(this, args);
      ChunkStore.prototype[method] = original;
      await new Promise(resolve => { globalThis.releaseStore = resolve; globalThis.checkpoint = true; });
      return result;
    };
  }, stage);
  const id = await page.evaluate(async stage => {
    const { id } = await window.meeting.prepare();
    await window.meeting.acquired(id);
    globalThis.appendDone = window.meeting.append(id, { meta: { version: 1, sessionId: id, epoch: 0,
      source: 'microphone', seq: 0, startFrame: 0, frames: 160, sampleRate: 16000, channels: 1 }, pcm: new Uint8Array(320) });
    if (stage === 'sealing') await appendDone;
    await window.meeting.stop(id, { microphone: 160, remote: 0 });
    globalThis.finishResult = null;
    window.meeting.finish(id).then(value => { finishResult = { value }; }, error => { finishResult = { error: error.message }; });
    return id;
  }, stage);
  // Poll the actual Main checkpoint, not a timing guess about disk throughput.
  await assertCheckpoint(app);
  const root = join(directory, 'recordings', id);
  assert.equal((await inspectRecording(root)).state, 'incomplete');
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); powerMonitor.emit('resume'); releaseStore(); });
  await page.waitForFunction(() => finishResult !== null);
  const result = await page.evaluate(async () => { await appendDone; return finishResult; });
  if (stage === 'draining') assert.match(result.error, /절전/);
  else assert.equal(result.value.state, 'stopped');
  assert.equal((await inspectRecording(root)).state, stage === 'draining' ? 'incomplete' : 'complete');
  const index = await new ChunkStore(root).index();
  assert.deepEqual(index.errors, []); assert.equal(index.chunks.length, 1);
});

async function assertCheckpoint(app) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await app.evaluate(() => globalThis.checkpoint)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Main storage checkpoint was not reached');
}
