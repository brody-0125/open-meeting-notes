import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('SAPI tool validates before writes, emits mono PCM/hash, and requires explicit overwrite', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-speech-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../tools/audio/prepare-speech.ps1', import.meta.url));
  const corpus = join(root, 'corpus.json'), output = join(root, 'audio');
  const run = (...extra) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-CorpusPath', corpus, '-OutputDirectory', output, ...extra], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  // Exercise explicit voice selection; this check requires Microsoft Zira Desktop.
  const voice = ['-VoiceName', 'Microsoft Zira Desktop'];
  const valid = { id: 'case-1', text: 'Please check the report.', voiceRate: 4, leadSilenceMs: 100, tailSilenceMs: 100 };
  await writeFile(corpus, JSON.stringify([valid, { ...valid, id: '../outside' }]));
  const invalid = run(...voice); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Invalid or duplicate fixture ID/);
  await assert.rejects(access(output), { code: 'ENOENT' });
  await writeFile(corpus, JSON.stringify([valid]));
  const created = run(...voice); assert.equal(created.status, 0, created.stderr);
  const path = join(output, 'case-1.wav'), wav = await readFile(path);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  const fmt = wav.indexOf(Buffer.from('fmt ')); assert.ok(fmt >= 12);
  assert.equal(wav.readUInt16LE(fmt + 8), 1); // PCM
  assert.equal(wav.readUInt16LE(fmt + 10), 1); // mono
  assert.equal(wav.readUInt32LE(fmt + 12), 16000);
  assert.equal(wav.readUInt16LE(fmt + 22), 16);
  assert.equal((await readFile(path + '.sha256', 'utf8')).trim(), createHash('sha256').update(wav).digest('hex'));
  const denied = run(...voice); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /Output exists/);
  assert.deepEqual(await readFile(path), wav);
  const overwritten = run(...voice, '-Force'); assert.equal(overwritten.status, 0, overwritten.stderr);
});
