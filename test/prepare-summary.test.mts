import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/prepare-summary-test.mjs', import.meta.url));

test('model preparation rejects unknown profiles before creating a pack', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-prepare-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const profile of ['unknown', '__proto__']) {
    await assert.rejects(run(process.execPath, [script, join(root, 'new-pack'), profile]), /supported fixtures/);
  }
  assert.deepEqual(await readdir(root), []);
});

test('model preparation never overwrites an existing fixture', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-prepare-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'manifest.json'), 'keep');
  await assert.rejects(run(process.execPath, [script, root, '8b']), /must be empty/);
  assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(root), ['manifest.json']);
});
