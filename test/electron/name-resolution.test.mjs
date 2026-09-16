import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

test('Chromium resolver rejects even localhost while custom local resources remain available', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-resolver-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: root } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  // localhost is locally resolved without consulting an external DNS server.
  // Checking failure here is stronger than resolving a nonexistent name.
  const results = await app.evaluate(async ({ session }) => {
    const results = [];
    for (const source of ['any', 'system', 'dns', 'localOnly']) for (const queryType of ['A', 'AAAA']) {
      try {
        await session.defaultSession.resolveHost('localhost', { source, queryType, cacheUsage: 'disallowed' });
        results.push({ source, queryType, resolved: true });
      } catch (error) { results.push({ source, queryType, error: error.message }); }
    }
    return results;
  });
  for (const result of results) assert.match(result.error ?? '', /ERR_NAME_NOT_RESOLVED/, JSON.stringify(result));
  assert.equal(await page.evaluate(async () => (await fetch('/app.mjs')).status), 200);
  assert.equal(await page.getByRole('button', { name: '녹음 준비', exact: true }).count(), 1);
  t.diagnostic(JSON.stringify({ resolverChecks: results.length, localResourceStatus: 200 }));
});
