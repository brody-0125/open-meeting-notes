import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('macOS packager rejects apple STT without built helper', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-macos-apple-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = JSON.stringify({ version: 1, engine: 'apple-speech-transcriber', allowedLocales: ['ko-KR'], allowedPresets: ['offlineTranscription'] });
  await writeFile(join(root, 'apple-stt-capability.json'), capability);
  const config = join(root, 'installed.json');
  await writeFile(config, JSON.stringify({ version: 1, stt: { backend: 'apple', locale: 'ko-KR', preset: 'offlineTranscription',
    approvedCapabilityHash: createHash('sha256').update(capability).digest('hex') } }));
  await assert.rejects(promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../../scripts/package-macos.mjs', import.meta.url)), join(root, 'out'), config],
    { timeout: 25000 }), /omn-speech-helper/);
});

test('macOS packager script is host-gated', { skip: process.platform === 'darwin' }, async () => {
  await assert.rejects(promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../../scripts/package-macos.mjs', import.meta.url))],
    { timeout: 5000 }), /requires macOS/);
});
