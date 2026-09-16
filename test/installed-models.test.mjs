import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { installedModels } from '../src/electron/installed-models.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
test('relative installation roots require an explicit trusted base and survive relocation', async t => {
  const config = await fixture(t), original = config.stt.root;
  config.stt.root = basename(original);
  await assert.rejects(installedModels(config), /base|absolute/);
  const first = await installedModels(config, { baseDirectory: dirname(original) });
  assert.equal(first.status.stt.modelHash, config.stt.approvedManifestHash);
  const moved = await mkdtemp(join(tmpdir(), 'omn-relocated-'));
  t.after(() => rm(moved, { recursive: true, force: true }));
  await rename(original, join(moved, config.stt.root));
  const second = await installedModels(config, { baseDirectory: moved });
  assert.deepEqual(second.status, first.status);
  assert.equal((await second.files.values().next().value()).toString(), 'synthetic');
  for (const unsafe of ['../escape', './pack', 'nested/../pack', 'C:pack', 'https://host/pack', 'pack\\nested', 'pack//nested']) {
    await assert.rejects(installedModels({ ...config, stt: { ...config.stt, root: unsafe } }, { baseDirectory: moved }), /relative|absolute/);
  }
});
async function fixture(t, extra = []) {
  const root = await mkdtemp(join(tmpdir(), 'omn-installed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [path, role] of [['models/whisper-tiny/model.onnx', 'weights'], ['models/whisper-tiny/tokenizer.json', 'tokenizer'],
    ['models/whisper-tiny/config.json', 'config'], ['runtime/ort-wasm-simd-threaded.jsep.wasm', 'runtime'], ...extra]) {
    const bytes = Buffer.from('synthetic');
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
    files.push({ path, role, bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = JSON.stringify({ version: 1, id: 'test-model', engine: 'transformers', engineVersion: '4.3.0', files });
  await writeFile(join(root, 'manifest.json'), manifest);
  return { version: 1, stt: { root, approvedManifestHash: sha(manifest), modelId: 'whisper-tiny' } };
}
test('missing installation yields no inference assets, valid installation exposes only verified files', async t => {
  assert.equal((await installedModels()).files.size, 0);
  const config = await fixture(t);
  const result = await installedModels(config);
  assert.equal(result.status.stt.modelId, 'whisper-tiny');
  assert.equal(result.status.stt.modelHash, config.stt.approvedManifestHash);
  assert.equal(result.status.summary, null);
  assert.equal(result.files.size, 4);
  assert.ok([...result.files.keys()].every(path => path.startsWith(`/packs/${config.stt.approvedManifestHash}/`)));
  assert.equal(result.files.has('/models/whisper-tiny/model.onnx'), false);
});
test('even approved pack cannot replace application routes', async t => {
  const config = await fixture(t, [['app.mjs', 'runtime']]);
  await assert.rejects(installedModels(config), /route/);
});

test('approved STT pack can expose the pinned local WebGPU runtime pair', async t => {
  const config = await fixture(t, [['runtime/ort-wasm-simd-threaded.asyncify.mjs', 'runtime'],
    ['runtime/ort-wasm-simd-threaded.asyncify.wasm', 'runtime']]);
  const result = await installedModels(config);
  assert.equal(result.files.size, 6);
  assert.ok([...result.files.keys()].some(path => path.endsWith('/ort-wasm-simd-threaded.asyncify.wasm')));
});

test('summary installation reports the verified pack identity rather than a hardcoded model size', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-installed-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [path, role] of [['models/qwen/resolve/main/weights.bin', 'weights'], ['models/qwen/resolve/main/tokenizer.json', 'tokenizer'],
    ['models/qwen/resolve/main/mlc-chat-config.json', 'config'], ['runtime/qwen.wasm', 'runtime']]) {
    const bytes = Buffer.from('fixture'); await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
    files.push({ path, role, bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = JSON.stringify({ version: 1, id: 'qwen-8b-test', engine: 'webllm', engineVersion: '0.2.85', files });
  await writeFile(join(root, 'manifest.json'), manifest);
  const result = await installedModels({ version: 1, summary: { root, approvedManifestHash: sha(manifest) } });
  assert.equal(result.status.summary.modelId, 'qwen-8b-test');
});
test('corrupt or unapproved assets fail without a partial installation result', async t => {
  const config = await fixture(t);
  await writeFile(join(config.stt.root, 'models/whisper-tiny/model.onnx'), 'tampered');
  await assert.rejects(installedModels(config), /size|integrity/);
});

test('served model bytes are verified again after installation, not only at startup', async t => {
  const config = await fixture(t), installed = await installedModels(config);
  const route = `/packs/${config.stt.approvedManifestHash}/models/whisper-tiny/model.onnx`;
  const path = join(config.stt.root, 'models/whisper-tiny/model.onnx');
  const read = installed.files.get(route);
  const original = await read();
  assert.equal(original.toString(), 'synthetic');
  await writeFile(path, 'Synthetic');
  await assert.rejects(read(), /integrity/);
  assert.equal(original.toString(), 'synthetic', 'already validated response owns its bytes');
  await writeFile(path, 'extra-long-data');
  await assert.rejects(read(), /size|integrity/);
  await rm(path); await assert.rejects(read(), /ENOENT/);
  assert.equal(installed.files.has('/app.mjs'), false);
  await writeFile(path, 'synthetic');
  await rename(join(config.stt.root, 'models'), join(config.stt.root, 'original-models'));
  await symlink(join(config.stt.root, 'original-models'), join(config.stt.root, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(read(), /link/);
});

test('VAD-only installation exposes exact hashed model and runtime paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-installed-vad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const path of ['models/silero.onnx', 'vad-runtime/ort-wasm-simd-threaded.mjs', 'vad-runtime/ort-wasm-simd-threaded.wasm']) {
    const bytes = Buffer.from('fixture'); await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
    files.push({ path, role: path.endsWith('.onnx') ? 'weights' : 'runtime', bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = JSON.stringify({ version: 1, id: 'vad', engine: 'silero', engineVersion: '1.31.0-dev.20260914-8d85527a0', files });
  await writeFile(join(root, 'manifest.json'), manifest);
  const result = await installedModels({ version: 1, vad: { root, approvedManifestHash: sha(manifest) } });
  assert.equal(result.status.vad.modelId, 'silero');
  assert.equal(result.status.stt, null); assert.equal(result.files.size, 3);
  assert.ok([...result.files.keys()].every(path => path.startsWith(`/packs/${sha(manifest)}/`)));
});
