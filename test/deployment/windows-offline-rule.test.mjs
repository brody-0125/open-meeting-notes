import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('Windows firewall helper previews a pinned executable and rejects tampering without policy writes', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-firewall-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = Buffer.from('not an executable; preview fixture only');
  const program = join(root, 'open-meeting-notes.exe'); await writeFile(program, bytes);
  const manifest = JSON.stringify({ version: 1, platform: 'win32-x64', files: [{ path: 'open-meeting-notes.exe', bytes: bytes.length, sha256: hash(bytes) }] });
  await writeFile(join(root, 'build-manifest.json'), manifest);
  const run = (approved = hash(manifest), action = 'Install') => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('../../scripts/windows-offline-rule.ps1', import.meta.url)), '-PackageRoot', root,
    '-ApprovedManifestHash', approved, '-Action', action, '-WhatIf'], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
  const install = JSON.parse(run().trim().split(/\r?\n/).at(-1));
  assert.equal(install.program, program); assert.equal(install.status, 'planned'); assert.equal(install.effectivePolicyVerified, false);
  assert.match(install.name, /^open-meeting-notes-offline-[a-f0-9]{24}$/);
  const remove = JSON.parse(run(hash(manifest), 'Remove').trim().split(/\r?\n/).at(-1));
  assert.equal(remove.name, install.name); assert.equal(remove.status, 'planned');
  assert.throws(() => run('0'.repeat(64)), /Manifest integrity mismatch/);
  await writeFile(program, 'changed');
  assert.throws(() => run(), /Executable integrity mismatch/);
});
