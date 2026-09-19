import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test('pinned speech.wav matches sha256 manifest', async () => {
  const wav = await readFile(fileURLToPath(new URL('./fixtures/speech.wav', import.meta.url)));
  const expected = (await readFile(fileURLToPath(new URL('./fixtures/speech.wav.sha256', import.meta.url)), 'utf8')).trim().toLowerCase();
  assert.equal(createHash('sha256').update(wav).digest('hex'), expected);
});
