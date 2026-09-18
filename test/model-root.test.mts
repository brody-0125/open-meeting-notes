import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyModelPack, readVerifiedModelAsset } from '../src/model-pack.mjs';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';

test('model roots require an explicit local absolute path before filesystem access', async () => {
  for (const root of ['relative-model-pack', '', 'file:///models', 'https://example.invalid/model',
    `${parse(tmpdir()).root}model/../other`, `${parse(tmpdir()).root}model/./other`]) {
    await assert.rejects(verifyModelPack({ root, approvedManifestHash: 'a'.repeat(64), engine: 'webllm', engineVersion: '0.2.85' }), /absolute local model path/);
  }
});

test('root and ancestor links are rejected before traversing into a model directory', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omn-model-root-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'target'); await mkdir(join(target, 'nested'), { recursive: true });
  const linked = join(directory, 'linked');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const root of [linked, join(linked, 'nested')]) {
    await assert.rejects(verifyModelPack({ root, approvedManifestHash: 'a'.repeat(64), engine: 'webllm', engineVersion: '0.2.85' }), /model directory link/);
    await assert.rejects(readVerifiedModelAsset({ root }, { path: 'weights.bin' }), /model directory link/);
  }
});

test('UNC and device namespace roots are rejected before resolving or serving assets', async () => {
  for (const root of ['\\\\example.invalid\\models', '//example.invalid/models', '\\\\?\\UNC\\example.invalid\\models', '\\\\.\\C:\\models',
    ...(process.platform === 'win32' ? ['C:models', '\\models', '/models', '/\\example.invalid/models'] : [])]) {
    await assert.rejects(verifyModelPack({ root, approvedManifestHash: 'a'.repeat(64), engine: 'webllm', engineVersion: '0.2.85' }), /absolute local model path/);
    await assert.rejects(readVerifiedModelAsset({ root }, { path: 'weights.bin' }), /absolute local model path/);
  }
});
