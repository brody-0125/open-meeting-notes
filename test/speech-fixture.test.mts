import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

for (const name of ['speech', 'beta-launch']) test(`pinned ${name}.wav matches sha256 manifest`, async () => {
  const wav = await readFile(fileURLToPath(new URL(`./fixtures/${name}.wav`, import.meta.url)));
  const expected = (await readFile(fileURLToPath(new URL(`./fixtures/${name}.wav.sha256`, import.meta.url)), 'utf8')).trim().toLowerCase();
  assert.equal(createHash('sha256').update(wav).digest('hex'), expected);
});
