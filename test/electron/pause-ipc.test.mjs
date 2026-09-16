import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRecording } from '../../src/recording-seal.mjs';

for (const suspend of [false, true]) test(`product pause IPC protects active session through ${suspend ? 'suspend' : 'close and resume'}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omn-pause-ipc-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => {
    const window = await app.firstWindow().catch(() => null);
    await window?.evaluate(() => globalThis.pauseSession && meeting.abort(pauseSession, 'test cleanup').catch(() => {})).catch(() => {});
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  const result = await page.evaluate(async () => {
    const { id } = await meeting.prepare(); await meeting.acquired(id);
    globalThis.pauseSession = id; globalThis.stopRequests = 0;
    meeting.onStopRequested(() => { stopRequests++; });
    for (const source of ['microphone', 'remote']) await meeting.append(id, {
      meta: { version: 1, sessionId: id, epoch: 0, source, seq: 0, startFrame: 0, frames: 2, sampleRate: 48000, channels: 1 },
      pcm: new ArrayBuffer(4)
    });
    const boundary = { pauseId: 1, cutoffs: { microphone: 2, remote: 2 } };
    const stalePause = await meeting.pause('stale', boundary).then(() => false, () => true);
    await meeting.pause(id, boundary);
    const failures = [];
    for (const call of [() => meeting.prepare(), () => meeting.inspect(id),
      () => meeting.analyze(id, crypto.randomUUID(), 'ko'), () => meeting.recoverAudio(id)])
      failures.push(await call().then(() => false, () => true));
    return { id, stalePause, failures, listed: await meeting.list() };
  });
  assert.equal(result.stalePause, true); assert.deepEqual(result.failures, [true, true, true, true]);
  assert.ok(!result.listed.some(item => item.id === result.id));
  if (suspend) {
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
    await page.waitForFunction(() => stopRequests > 0);
    const denied = await page.evaluate(() => meeting.resume(pauseSession, {
      pauseId: 1, starts: { microphone: 10, remote: 12 }
    }).then(() => false, () => true));
    assert.equal(denied, true);
    assert.equal((await inspectRecording(join(directory, 'recordings', result.id))).state, 'incomplete');
  } else {
    assert.equal(await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.close(); return window.isDestroyed();
    }), false);
    await page.waitForFunction(() => stopRequests > 0);
    await page.evaluate(async () => {
      await meeting.resume(pauseSession, { pauseId: 1, starts: { microphone: 10, remote: 12 } });
      for (const [source, startFrame] of [['microphone', 10], ['remote', 12]]) await meeting.append(pauseSession, {
        meta: { version: 1, sessionId: pauseSession, epoch: 0, source, seq: 1, startFrame, frames: 2, sampleRate: 48000, channels: 1 },
        pcm: new ArrayBuffer(4)
      });
      await meeting.stop(pauseSession, { microphone: 12, remote: 14 }); await meeting.finish(pauseSession);
    });
    const verified = await inspectRecording(join(directory, 'recordings', result.id));
    assert.equal(verified.state, 'complete'); assert.equal(verified.version, 2);
  }
});
