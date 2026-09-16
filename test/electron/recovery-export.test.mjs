import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';

test('Main recovery rejects competing work and releases its lock after success and failure', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omn-recovery-lock-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {});
    await app.close(); await rm(directory, { recursive: true, force: true });
  });
  const page = await app.firstWindow(), id = '44444444-4444-4444-8444-444444444444';
  const store = new ChunkStore(join(directory, 'recordings', id));
  await store.put({ version: 1, sessionId: id, epoch: 0, source: 'microphone', seq: 0,
    startFrame: 0, frames: 160, sampleRate: 16000, channels: 1 }, Buffer.alloc(320));
  for (const fail of [false, true]) {
    await app.evaluate((_, fail) => {
      const original = testChunkStore.prototype.index;
      let calls = 0;
      globalThis.reachedRecovery = new Promise(resolve => { globalThis.signalRecovery = resolve; });
      testChunkStore.prototype.index = async function () {
        if (++calls === 1) return original.call(this); // Initial source-state inspection precedes the export index.
        testChunkStore.prototype.index = original;
        await new Promise(resolve => { globalThis.releaseRecovery = resolve; signalRecovery(); });
        if (fail) throw new Error('injected recovery read failure');
        return original.call(this);
      };
    }, fail);
    await page.evaluate(id => {
      globalThis.recoveryOutcome = null;
      window.meeting.recoverAudio(id).then(result => { recoveryOutcome = { result }; }, error => { recoveryOutcome = { error: error.message }; });
    }, id);
    await app.evaluate(() => reachedRecovery);
    const blocked = await page.evaluate(async id => {
      const results = await Promise.allSettled([window.meeting.prepare(), window.meeting.analyze(id, crypto.randomUUID(), 'ko'), window.meeting.recoverAudio(id)]);
      return results.map(r => ({ status: r.status, message: r.reason?.message }));
    }, id);
    assert.ok(blocked.every(r => r.status === 'rejected' && /busy|active/.test(r.message)));
    await app.evaluate(() => releaseRecovery());
    await page.waitForFunction(() => recoveryOutcome !== null);
    const outcome = await page.evaluate(() => recoveryOutcome);
    if (fail) assert.match(outcome.error, /injected/);
    else assert.equal(outcome.result.spans, 1);
    const session = await page.evaluate(() => window.meeting.prepare());
    assert.ok(session.id);
    await page.evaluate(id => window.meeting.abort(id, 'test cleanup'), session.id);
  }
  await assert.rejects(page.evaluate(() => window.meeting.recoverAudio('../escape')), /invalid recording id/);
  assert.equal((await readdir(join(directory, 'exports'))).length, 1);
});
