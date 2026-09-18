import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { verifyDevelopmentPackage } from '../../src/package-integrity.mjs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { inspectRecording } from '../../src/recording-seal.mjs';
import { ChunkStore } from '../../src/store.mjs';

test('packaged executable verifies its build inventory and records without a source checkout entrypoint', { timeout: 60000 }, async t => {
  assert.ok(process.env.OMN_WINDOWS_PACKAGE);
  const root = resolve(process.env.OMN_WINDOWS_PACKAGE);
  const manifest = await verifyDevelopmentPackage({ root, approvedManifestHash: process.env.OMN_PACKAGE_MANIFEST_HASH });
  assert.equal(manifest.signed, false);
  const profile = await mkdtemp(join(tmpdir(), 'omn-packaged-'));
  const app = await electron.launch({ executablePath: join(root, 'open-meeting-notes.exe'), args: [`--user-data-dir=${profile}`] });
  t.after(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {});
    await app.close(); await rm(profile, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  const info = await app.evaluate(async ({ app, dialog, BrowserWindow, session }) => {
    BrowserWindow.getAllWindows().forEach(w => w.hide());
    dialog.showMessageBox = async () => ({ response: 1 }); // Test consent only, no real device access.
    return { packaged: app.isPackaged, version: app.getVersion(), userData: app.getPath('userData'),
      resolverRules: app.commandLine.getSwitchValue('host-resolver-rules'),
      rtcPolicy: BrowserWindow.getAllWindows()[0].webContents.getWebRTCIPHandlingPolicy(),
      proxy: await session.defaultSession.resolveProxy('https://example.invalid/') };
  });
  assert.equal(info.packaged, true); assert.equal(info.version, manifest.appVersion); assert.equal(info.userData, profile);
  assert.equal(info.resolverRules, 'MAP * ^NOTFOUND');
  assert.equal(info.rtcPolicy, 'disable_non_proxied_udp');
  assert.match(info.proxy, /^PROXY 127\.0\.0\.1:\d+$/);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.evaluate(() => {
    const ctx = new AudioContext();
    const source = () => { const osc = ctx.createOscillator(), out = ctx.createMediaStreamDestination(); osc.connect(out); osc.start(); return out.stream; };
    navigator.mediaDevices.getDisplayMedia = async () => { await ctx.resume(); return source(); };
    navigator.mediaDevices.getUserMedia = async () => source();
  });
  await page.getByRole('button', { name: '녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByText('입력 확인 중', { exact: true }).waitFor();
  await page.waitForFunction(() => ['microphone', 'remote'].every(source => document.getElementById(`${source}-level`).value > -10));
  assert.deepEqual(await readdir(join(profile, 'recordings')), []);
  assert.equal(await page.locator('#timer').innerText(), '00:00');
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '일시정지', exact: true }).click();
  await page.getByText('녹음 일시정지', { exact: true }).waitFor();
  const [pausedId] = await readdir(join(profile, 'recordings'));
  const pausedStore = new ChunkStore(join(profile, 'recordings', pausedId));
  const pausedIndex = await pausedStore.index();
  await page.waitForTimeout(250);
  assert.deepEqual(await pausedStore.index(), pausedIndex);
  await page.getByRole('button', { name: '녹음 재개', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '녹음 종료', exact: true }).click();
  await page.getByText('녹음 저장 완료', { exact: true }).waitFor();
  const ids = await readdir(join(profile, 'recordings')); assert.equal(ids.length, 1);
  const verified = await inspectRecording(join(profile, 'recordings', ids[0]));
  assert.equal(verified.state, 'complete'); assert.equal(verified.pauses.length, 1);
  for (const source of ['microphone', 'remote'])
    assert.ok(verified.pauses[0].starts[source] > verified.pauses[0].cutoffs[source]);
  await page.getByRole('button', { name: '새 녹음 준비', exact: true }).click();
  await page.getByRole('button', { name: '입력 선택 및 확인' }).click();
  await page.getByRole('button', { name: '녹음 시작', exact: true }).click();
  await page.getByText('녹음 중', { exact: true }).waitFor();
  await page.waitForTimeout(1200);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await page.getByText('녹음이 완료되지 않았습니다', { exact: true }).waitFor({ timeout: 3000 });
  const interrupted = (await readdir(join(profile, 'recordings'))).find(id => id !== ids[0]);
  assert.ok(interrupted);
  const interruptedRoot = join(profile, 'recordings', interrupted);
  const snapshot = async () => Promise.all((await readdir(interruptedRoot)).sort().map(async file =>
    [file, await readFile(join(interruptedRoot, file))]));
  const before = await snapshot();
  await page.getByRole('button', { name: '목록 새로고침' }).click();
  const row = page.locator('#records li').filter({ hasText: interrupted });
  await row.getByRole('button', { name: '오디오 검증', exact: true }).click();
  await row.getByRole('button', { name: '검증된 오디오 복구 저장', exact: true }).click();
  const status = row.locator('p').filter({ hasText: '복구 오디오 저장:' }); await status.waitFor();
  const exportPath = (await status.innerText()).split('복구 오디오 저장: ')[1];
  const recovered = JSON.parse(await readFile(join(exportPath, 'recovery.json'), 'utf8'));
  assert.equal(recovered.state, 'recovered-excerpts'); assert.equal(recovered.originalState, 'incomplete');
  assert.deepEqual(new Set(recovered.spans.map(s => s.source)), new Set(['microphone', 'remote']));
  for (const span of recovered.spans) {
    const wav = await readFile(join(exportPath, span.file));
    assert.equal(wav.length, 44 + span.frames * span.channels * 2);
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal((await inspectRecording(interruptedRoot)).state, 'incomplete');
  assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify({ filesVerified: manifest.files.length, packaged: info.packaged, version: info.version }));
});
