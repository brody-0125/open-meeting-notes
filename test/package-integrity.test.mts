import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyDevelopmentPackage } from '../src/package-integrity.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, edit = m => m) {
  const root = await mkdtemp(join(tmpdir(), 'omn-package-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'resources/app'), { recursive: true });
  const files = [];
  for (const path of ['open-meeting-notes.exe', 'resources/app/package.json']) {
    const bytes = Buffer.from('synthetic'); await writeFile(join(root, path), bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = edit({ version: 1, appVersion: '1.0.0', electronVersion: '44.4.1', platform: 'win32-x64', signed: false, files });
  const bytes = JSON.stringify(manifest); await writeFile(join(root, 'build-manifest.json'), bytes);
  return { root, approvedManifestHash: hash(bytes) };
}
test('package inventory requires an independently approved manifest hash', async t => {
  const input = await fixture(t);
  assert.equal((await verifyDevelopmentPackage(input)).files.length, 2);
  await assert.rejects(verifyDevelopmentPackage({ ...input, approvedManifestHash: undefined }), /approved/);
  await assert.rejects(verifyDevelopmentPackage({ ...input, approvedManifestHash: '0'.repeat(64) }), /manifest integrity/);
});
test('package verification rejects changed, missing and unlisted files', async t => {
  const input = await fixture(t), path = join(input.root, 'open-meeting-notes.exe');
  await writeFile(path, 'Synthetic'); await assert.rejects(verifyDevelopmentPackage(input), /integrity/);
  await writeFile(path, 'synthetic');
  await writeFile(join(input.root, 'injected.dll'), 'extra'); await assert.rejects(verifyDevelopmentPackage(input), /unlisted/);
  await rm(join(input.root, 'injected.dll')); await rm(path);
  await assert.rejects(verifyDevelopmentPackage(input), /missing/);
});
test('package paths reject traversal, aliases, streams and duplicate names before inventory access', async t => {
  for (const path of ['../outside', '/outside', 'C:/outside', 'dir\\file', 'name:stream', 'CON', 'file.', 'file ', 'build-manifest.json']) {
    const input = await fixture(t, m => ({ ...m, files: [{ ...m.files[0], path }] }));
    await assert.rejects(verifyDevelopmentPackage(input), /path/);
  }
  const input = await fixture(t, m => ({ ...m, files: [...m.files, { ...m.files[0], path: 'OPEN-MEETING-NOTES.EXE' }] }));
  await assert.rejects(verifyDevelopmentPackage(input), /duplicate/);
});
test('package directory junctions and unsupported manifest metadata fail closed', async t => {
  const input = await fixture(t);
  await symlink(join(input.root, 'resources'), join(input.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyDevelopmentPackage(input), /link/);
  for (const edit of [m => ({ ...m, signed: true }), m => ({ ...m, files: [] }), m => ({ ...m, extra: true })]) {
    await assert.rejects(verifyDevelopmentPackage(await fixture(t, edit)), /manifest/);
  }
});
