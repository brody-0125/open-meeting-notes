import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyModelPack } from '../src/model-pack.mjs';
const digest = b => createHash('sha256').update(b).digest('hex');

test('Silero pack requires weights and runtime without a tokenizer', async t => {
  const f = await fixture(t, m => ({ ...m, engine: 'silero', files: m.files.filter(f => ['weights', 'runtime'].includes(f.role)) }));
  assert.equal((await verifyModelPack({ ...f, engine: 'silero' })).files.length, 2);
  const missing = await fixture(t, m => ({ ...m, engine: 'silero', files: m.files.filter(f => f.role === 'weights') }));
  await assert.rejects(verifyModelPack({ ...missing, engine: 'silero' }), /runtime/);
});

async function fixture(t, edit = x => x) {
  const root = await mkdtemp(join(tmpdir(), 'omn-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [role, path] of [['weights', 'weights.bin'], ['tokenizer', 'tokenizer.json'], ['config', 'config.json'], ['runtime', 'engine.wasm']]) {
    const bytes = Buffer.from(`synthetic-${role}`);
    await writeFile(join(root, path), bytes);
    files.push({ path, role, bytes: bytes.length, sha256: digest(bytes) });
  }
  const manifest = edit({ version: 1, id: 'test-pack', engine: 'transformers', engineVersion: '4.3.0', files });
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, 'manifest.json'), bytes);
  return { root, approvedManifestHash: digest(bytes), engine: 'transformers', engineVersion: '4.3.0', manifest };
}

test('C10 verifies a pinned local manifest and every required asset', async t => {
  const f = await fixture(t);
  const pack = await verifyModelPack(f);
  assert.equal(pack.id, 'test-pack');
  assert.equal(pack.manifestHash, f.approvedManifestHash);
  assert.equal(pack.files.length, 4);
  assert.equal(Object.isFrozen(pack.files), true);
});
test('C10 rejects untrusted manifest even if every file checksum is valid', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyModelPack({ ...f, approvedManifestHash: '0'.repeat(64) }), /manifest integrity/);
  await assert.rejects(verifyModelPack({ ...f, approvedManifestHash: undefined }), /approved/);
});
test('C10 missing and modified assets fail locally', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'weights.bin'), Buffer.from('Synthetic-weights'));
  await assert.rejects(verifyModelPack(f), /integrity/);
  await writeFile(join(f.root, 'weights.bin'), Buffer.from('bad'));
  await assert.rejects(verifyModelPack(f), /size|integrity/);
  await rm(join(f.root, 'weights.bin'));
  await assert.rejects(verifyModelPack(f), /ENOENT/);
});
test('C10 rejects incompatible engine and incomplete asset roles', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyModelPack({ ...f, engineVersion: '0.0.0' }), /engine/);
  const incomplete = await fixture(t, m => ({ ...m, files: m.files.filter(f => f.role !== 'runtime') }));
  await assert.rejects(verifyModelPack(incomplete), /runtime/);
});
test('C11 rejects traversal, URLs, Windows paths and case aliases', async t => {
  for (const path of ['../secret', '/secret', 'C:/secret', 'https://host/model', 'dir\\file', 'model:stream', 'dir/../model', 'CON', 'model.']) {
    const f = await fixture(t, m => ({ ...m, files: [{ ...m.files[0], path }, ...m.files.slice(1)] }));
    await assert.rejects(verifyModelPack(f), /path/);
  }
  const f = await fixture(t, m => ({ ...m, files: [...m.files, { ...m.files[0], path: 'WEIGHTS.BIN' }] }));
  await assert.rejects(verifyModelPack(f), /duplicate/);
});
test('C11 rejects junction escape into an external directory', async t => {
  const f = await fixture(t, m => ({ ...m, files: [{ ...m.files[0], path: 'linked/weights.bin' }, ...m.files.slice(1)] }));
  const outside = await mkdtemp(join(tmpdir(), 'omn-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'weights.bin'), Buffer.from('synthetic-weights'));
  await symlink(outside, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyModelPack(f), /link/);
});
