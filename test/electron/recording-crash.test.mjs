import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron as electron } from 'playwright';
import { ChunkStore } from '../../src/store.mjs';
import { inspectRecording } from '../../src/recording-seal.mjs';
import { analyzeRecording } from '../../src/analyze-recording.mjs';
import { PauseStore } from '../../src/pauses.mjs';

for (const mode of ['none', 'paused', 'resumed']) test(`Main crash preserves acknowledged PCM and pause metadata (${mode})`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-recording-crash-'));
  let app;
  const child = spawn(executablePath, [fileURLToPath(new URL('./recording-crash-main.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: root, OMN_CRASH_PAUSE: mode, ELECTRON_RUN_AS_NODE: undefined }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    await app?.close(); await rm(root, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('recording fixture did not acknowledge audio')), 10000);
    let output = '';
    child.stdout.on('data', bytes => {
      output += bytes;
      const line = output.split('\n').find(line => line.startsWith('recording-ready:'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('recording-ready:'.length))); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('recording fixture exited before readiness')); });
  });
  const expectedChunks = mode === 'resumed' ? 10 : 8;
  assert.equal(ready.acks.length, expectedChunks);
  assert.ok(ready.acks.every(ack => ack.durable));
  await new Promise((resolve, reject) => { child.once('exit', resolve); if (!child.kill('SIGKILL')) reject(new Error('fixture kill failed')); });
  const recordingRoot = join(root, 'recordings', ready.id), store = new ChunkStore(recordingRoot);
  const recovered = await store.recover();
  assert.deepEqual(recovered.errors, []); assert.deepEqual(recovered.partials, []);
  assert.equal(recovered.chunks.length, expectedChunks);
  const saved = new Map();
  const pauses = await new PauseStore(recordingRoot, ready.id).read();
  assert.deepEqual(pauses, mode === 'none' ? [] : [{ pauseId: 1,
    cutoffs: { microphone: 64000, remote: 64000 },
    starts: mode === 'resumed' ? { microphone: 80000, remote: 96000 } : null }]);
  if (mode !== 'none') saved.set('pauses.json', await readFile(join(recordingRoot, 'pauses.json')));
  let preservedSamples = 0;
  for (const ack of ready.acks) {
    const chunk = await store.read(ack.file);
    assert.equal(chunk.checksum, ack.checksum);
    const expected = (chunk.meta.source === 'microphone' ? 1 : -1) * (100 + chunk.meta.seq);
    for (let offset = 0; offset < chunk.pcm.length; offset += 2) assert.equal(chunk.pcm.readInt16LE(offset), expected);
    preservedSamples += chunk.pcm.length / 2;
    saved.set(ack.file, await readFile(join(recordingRoot, ack.file)));
  }
  assert.equal(preservedSamples, expectedChunks * 16000);
  assert.equal((await inspectRecording(recordingRoot)).state, 'incomplete');
  await assert.rejects(analyzeRecording({ root: recordingRoot, models: { stt: {}, summary: {} },
    execute: () => assert.fail('incomplete recording must not reach inference') }), /complete recording required/);
  app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: root } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '오디오 검증', exact: true }).click();
  await page.getByText('미완료 기록 · 복구 검토가 필요합니다.', { exact: true }).waitFor();
  assert.equal(await page.locator('#records li').count(), 1);
  await page.getByRole('button', { name: '검증된 오디오 복구 저장', exact: true }).click({ timeout: 2000 });
  const recoveredStatus = page.locator('#records li p').filter({ hasText: '복구 오디오 저장:' });
  await recoveredStatus.waitFor();
  const exportPath = (await recoveredStatus.innerText()).split('복구 오디오 저장: ')[1];
  const manifest = JSON.parse(await readFile(join(exportPath, 'recovery.json'), 'utf8'));
  assert.equal(manifest.originalState, 'incomplete'); assert.equal(manifest.spans.length, mode === 'resumed' ? 4 : 2);
  if (mode !== 'none') {
    assert.equal(manifest.pauseMetadata.verification, 'metadata-only');
    assert.deepEqual(manifest.pauseMetadata.records, pauses);
  }
  assert.deepEqual(manifest.spans.map(({ source, startFrame, frames }) => ({ source, startFrame, frames })),
    ['microphone', 'remote'].flatMap(source => [
      { source, startFrame: 0, frames: 64000 },
      ...(mode === 'resumed' ? [{ source, startFrame: source === 'microphone' ? 80000 : 96000, frames: 16000 }] : [])
    ]));
  for (const span of manifest.spans) {
    const wav = await readFile(join(exportPath, span.file));
    assert.equal(wav.readUInt32LE(40), span.frames * 2); assert.equal(wav.length, 44 + span.frames * 2);
  }
  for (const [file, bytes] of saved) assert.deepEqual(await readFile(join(recordingRoot, file)), bytes);
  assert.equal((await inspectRecording(recordingRoot)).state, 'incomplete');
  const file = ready.acks[0].file, bytes = saved.get(file);
  const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 1;
  await writeFile(join(recordingRoot, file), damaged);
  await page.getByRole('button', { name: '오디오 검증', exact: true }).click();
  await page.getByText('손상 감지 · 오디오를 확인해 주세요.', { exact: true }).waitFor();
  assert.deepEqual(await readFile(join(recordingRoot, file)), damaged);
  t.diagnostic(JSON.stringify({ acknowledgedChunks: ready.acks.length, preservedSamples, autoSealed: false, unsealedCorruptionDetected: true }));
});
