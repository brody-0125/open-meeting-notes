import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('Electron serves only approved model bytes after startup, including runtime assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-model-resource-')), pack = join(root, 'pack');
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const files = [];
  for (const [path, role] of [['models/whisper-tiny/model.onnx', 'weights'], ['models/whisper-tiny/tokenizer.json', 'tokenizer'],
    ['models/whisper-tiny/config.json', 'config'], ['runtime/ort-wasm-simd-threaded.jsep.wasm', 'runtime']]) {
    const bytes = Buffer.from('synthetic'); await mkdir(dirname(join(pack, path)), { recursive: true });
    await writeFile(join(pack, path), bytes); files.push({ path, role, bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = JSON.stringify({ version: 1, id: 'resource-fixture', engine: 'transformers', engineVersion: '4.3.0', files });
  await writeFile(join(pack, 'manifest.json'), manifest);
  app = await electron.launch({ args: [fileURLToPath(new URL('./model-resource-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_RESOURCE_TEST_PROFILE: join(root, 'profile'), OMN_RESOURCE_TEST_PACK: pack, OMN_RESOURCE_TEST_HASH: sha(manifest) } });
  const page = await app.firstWindow();
  assert.equal((await page.evaluate(() => window.meeting.models())).error, null);
  const fetchFile = path => page.evaluate(async path => {
    const response = await fetch(path, { cache: 'no-store' }); return { status: response.status, text: await response.text() };
  }, `/packs/${sha(manifest)}/${path}`);
  for (const asset of [files[0], files[3]]) {
    assert.deepEqual(await fetchFile(asset.path), { status: 200, text: 'synthetic' });
    await writeFile(join(pack, asset.path), 'Synthetic');
    assert.deepEqual(await fetchFile(asset.path), { status: 500, text: 'local resource verification failed' });
    await rm(join(pack, asset.path));
    assert.equal((await fetchFile(asset.path)).status, 500);
    await writeFile(join(pack, asset.path), 'synthetic');
    assert.equal((await fetchFile(asset.path)).status, 200);
  }
  assert.equal((await fetchFile('unlisted.bin')).status, 403);
});
