import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const action of ['cancel', 'close', 'suspend']) test(`preflight UI releases inputs without saving on ${action}`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-preflight-ui-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: root } });
  t.after(async () => {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const ctx = new AudioContext(); globalThis.testTracks = [];
    const input = () => {
      const tone = new OscillatorNode(ctx), out = ctx.createMediaStreamDestination();
      tone.connect(out); tone.start(); testTracks.push(...out.stream.getTracks()); return out.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => { await ctx.resume(); return input(); };
    navigator.mediaDevices.getUserMedia = async () => input();
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인', exact: true }).click();
  await page.getByText('입력 확인 중', { exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('remote-level').value > -10);
  assert.deepEqual(await readdir(join(root, 'recordings')), []);
  assert.equal(await page.locator('#timer').innerText(), '00:00');
  if (action === 'cancel') await page.getByRole('button', { name: '취소', exact: true }).click();
  else if (action === 'close') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  else await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await page.getByText('녹음 대기', { exact: true }).waitFor();
  await page.waitForFunction(() => testTracks.length === 2 && testTracks.every(track => track.readyState === 'ended'));
  assert.deepEqual(await readdir(join(root, 'recordings')), []);
  assert.equal(await page.locator('#microphone-level-text').innerText(), '측정 안 함');
  assert.deepEqual(errors, []);
});
