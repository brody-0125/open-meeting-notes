import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { installedModels } from '../src/electron/installed-models.mjs';
import { assertAnalysisLanguageMatchesSttLocale } from '../src/stt-settings.mjs';

const examples = dirname(fileURLToPath(new URL('../docs/examples/apple-stt-capability.json', import.meta.url)));

test('documented apple STT example capability verifies', async () => {
  const capability = await readFile(join(examples, 'apple-stt-capability.json'));
  const hash = createHash('sha256').update(capability).digest('hex');
  const result = await installedModels({
    version: 1,
    stt: { backend: 'apple', locale: 'ko-KR', preset: 'offlineTranscription', approvedCapabilityHash: hash }
  }, { baseDirectory: examples });
  assert.equal(result.status.stt.backend, 'apple');
  assert.equal(result.status.stt.modelHash, hash);
  assert.throws(() => assertAnalysisLanguageMatchesSttLocale(result.status.stt, 'en'), /locale/);
});
