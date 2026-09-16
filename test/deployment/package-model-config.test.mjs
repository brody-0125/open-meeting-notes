import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, mkdir, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('bundled package relocates with only approved model assets and no source pack', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-bundle-')), pack = join(root, 'source-pack');
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const sha = bytes => createHash('sha256').update(bytes).digest('hex'), files = [];
  for (const path of ['models/silero.onnx', 'vad-runtime/ort-wasm-simd-threaded.wasm', 'vad-runtime/ort-wasm-simd-threaded.mjs']) {
    const bytes = Buffer.from('synthetic-model');
    await mkdir(dirname(join(pack, path)), { recursive: true }); await writeFile(join(pack, path), bytes);
    files.push({ path, role: path.endsWith('.onnx') ? 'weights' : 'runtime', bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = JSON.stringify({ version: 1, id: 'bundle-vad', engine: 'silero', engineVersion: '1.31.0-dev.20260914-8d85527a0', files });
  await writeFile(join(pack, 'manifest.json'), manifest);
  await writeFile(join(pack, 'private-unlisted.txt'), 'must not be copied');
  const config = join(root, 'installed.json'), target = join(root, 'build');
  await writeFile(config, JSON.stringify({ version: 1, vad: { root: 'source-pack', approvedManifestHash: sha(manifest) } }));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../scripts/package-windows.mjs', import.meta.url)),
    target, config, '--bundle-models'], { windowsHide: true, timeout: 60000 });
  const moved = join(root, 'relocated'); await rename(target, moved);
  await rm(pack, { recursive: true, force: true });
  const installed = JSON.parse(await readFile(join(moved, 'resources/app/models/installed.json'), 'utf8'));
  assert.equal(installed.vad.root, 'packs/vad');
  await assert.rejects(access(join(moved, 'resources/app/models/packs/vad/private-unlisted.txt')), { code: 'ENOENT' });
  app = await electron.launch({ executablePath: join(moved, 'open-meeting-notes.exe'), args: [`--user-data-dir=${join(root, 'profile')}`] });
  const page = await app.firstWindow();
  const status = await page.evaluate(() => meeting.models());
  assert.equal(status.error, null); assert.equal(status.vad.modelHash, sha(manifest));
  assert.equal(await page.evaluate(async hash => (await fetch(`/packs/${hash}/models/silero.onnx`)).text(), sha(manifest)), 'synthetic-model');
});

test('packaging rejects invalid model installation metadata before creating output', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-package-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'package'), config = join(root, 'installed.json');
  await writeFile(config, JSON.stringify({ version: 999 }));
  await assert.rejects(promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../../scripts/package-windows.mjs', import.meta.url)), target, config],
    { windowsHide: true, timeout: 50000 }), /invalid model installation/);
  await assert.rejects(access(target), { code: 'ENOENT' });
});
