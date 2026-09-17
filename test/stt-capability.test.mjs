import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyAppleSttCapability } from '../src/electron/stt-capability.mjs';

test('approved capability hash must match file bytes', async t => {
  const base = await mkdtemp(join(tmpdir(), 'omn-cap-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const capability = JSON.stringify({ version: 1, engine: 'apple-speech-transcriber', allowedLocales: ['ko-KR'], allowedPresets: ['offlineTranscription'] });
  await writeFile(join(base, 'apple-stt-capability.json'), capability);
  const hash = createHash('sha256').update(capability).digest('hex');
  const result = await verifyAppleSttCapability({ baseDirectory: base, record: { locale: 'ko-KR', preset: 'offlineTranscription', approvedCapabilityHash: hash } });
  assert.equal(result.modelHash, hash);
  await assert.rejects(verifyAppleSttCapability({ baseDirectory: base, record: { locale: 'en-US', preset: 'offlineTranscription', approvedCapabilityHash: hash } }), /locale/);
});
