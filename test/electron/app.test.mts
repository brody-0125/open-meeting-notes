import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkStore } from '../../src/store.mjs';
import { inspectRecording } from '../../src/recording-seal.mjs';

test('app UI consent, synthetic acquisition, recording and durable stop', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omn-app-ui-'));
  let app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  assert.equal(await page.getByRole('button', { name: '입력 선택 및 확인' }).count(), 0);
  const screenshots = fileURLToPath(new URL('../../../../work/app-qa/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'idle.png') });
  await page.evaluate(() => {
    const ctx = new AudioContext();
    const source = frequency => {
      const osc = new OscillatorNode(ctx, { frequency });
      const out = ctx.createMediaStreamDestination();
      osc.connect(out); osc.start(); return out.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => { await ctx.resume(); return source(440); };
    navigator.mediaDevices.getUserMedia = async () => source(880);
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByText('입력 확인 중', { exact: true }).waitFor({ timeout: 2000 });
  await page.waitForFunction(() => document.getElementById('microphone-level').value > -10);
  assert.deepEqual(await readdir(join(directory, 'recordings')), []);
  assert.equal(await page.locator('#timer').innerText(), '00:00');
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshots, 'preflight.png'), fullPage: true });
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForFunction(() => ['microphone', 'remote'].every(source =>
    document.getElementById(`${source}-level`).value > -10));
  await page.screenshot({ path: join(screenshots, 'recording.png') });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '일시정지', exact: true }).click({ timeout: 2000 });
  await page.getByText('녹음 일시정지', { exact: true }).waitFor();
  for (const source of ['microphone', 'remote']) {
    assert.equal(await page.locator(`#${source}-level-text`).innerText(), '측정 안 함');
    assert.equal(await page.locator(`#${source}-level`).getAttribute('aria-valuetext'), '측정 안 함');
  }
  const [pausedId] = await readdir(join(directory, 'recordings'));
  const pausedStore = new ChunkStore(join(directory, 'recordings', pausedId));
  const pausedIndex = await pausedStore.index();
  await page.waitForTimeout(250);
  assert.deepEqual(await pausedStore.index(), pausedIndex);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshots, 'paused.png'), fullPage: true });
  await page.getByRole('button', { name: '녹음 재개', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '녹음 종료' }).click();
  await page.getByText('녹음 저장 완료', { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, 'saved.png') });
  const ids = await readdir(join(directory, 'recordings'));
  assert.equal(ids.length, 1);
  const recovered = await new ChunkStore(join(directory, 'recordings', ids[0])).recover();
  assert.deepEqual(recovered.errors, []);
  assert.ok(recovered.chunks.some(c => c.meta.source === 'microphone'));
  assert.ok(recovered.chunks.some(c => c.meta.source === 'remote'));
  const verified = await inspectRecording(join(directory, 'recordings', ids[0]));
  assert.equal(verified.state, 'complete'); assert.equal(verified.pauses.length, 1);
  for (const source of ['microphone', 'remote']) assert.ok(verified.pauses[0].starts[source] > verified.pauses[0].cutoffs[source]);
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(screenshots, 'narrow.png') });
  await page.getByRole('button', { name: '새 녹음 준비' }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).waitFor();
  assert.equal(await page.evaluate(async oldId => window.meeting.abort(oldId, 'stale request').then(() => false, () => true), ids[0]), true);
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => { globalThis.grantLate = resolve; });
  });
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByText('녹음 대기', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => {
    const ctx = new AudioContext();
    const stream = ctx.createMediaStreamDestination().stream;
    globalThis.grantLate(stream);
    await new Promise(resolve => setTimeout(resolve, 50));
    const stopped = stream.getTracks().every(track => track.readyState === 'ended');
    await ctx.close(); return stopped;
  }), true);
  assert.equal(await page.getByText('녹음 대기', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  await app.close();
  app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  const reopened = await app.firstWindow();
  await reopened.getByRole('button', { name: '오디오 검증', exact: true }).click();
  await reopened.getByText(/완료 확인 ·/).waitFor();
  assert.equal(await reopened.locator('#records li').count(), 1);
  assert.equal(await reopened.evaluate(async () => window.meeting.inspect('../outside').then(() => false, () => true)), true);
  await reopened.screenshot({ path: join(screenshots, 'library.png'), fullPage: true });
  await reopened.setViewportSize({ width: 390, height: 760 });
  assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await reopened.screenshot({ path: join(screenshots, 'library-narrow.png'), fullPage: true });
});
