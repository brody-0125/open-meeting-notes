import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { prepareScanMerge } from '../../src/reconciliation-merge.mjs';
import { validateCandidateGroups } from '../../src/inference/reconciliation-groups.mjs';

test('actual local group planner separates schedule revision from unspecified uncertainty', { timeout: 120000 }, async t => {
  assert.ok(process.env.OMN_STT_FIXTURE && process.env.OMN_SUMMARY_FIXTURE && process.env.OMN_SYNTHETIC_SCAN_OUTPUT);
  const bytes = await readFile(process.env.OMN_SYNTHETIC_SCAN_OUTPUT);
  const fixtureHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(fixtureHash, 'd35dc04617a793e26fd2a07f35757193b268021d100e265c9cd1df94ae8466c1');
  const fixture = JSON.parse(bytes), { input } = prepareScanMerge(fixture.transcript, fixture.scanned);
  const directory = await mkdtemp(join(tmpdir(), 'omn-group-semantics-'));
  const app = await electron.launch({ args: [fileURLToPath(new URL('./app-model-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  t.diagnostic(JSON.stringify({ fixtureHash, scanModelHash: fixture.descriptor.modelHash }));
  const { plan, modelHash } = await page.evaluate(async input => {
    const { InferenceClient } = await import('/inference-client.mjs');
    const client = new InferenceClient(), models = await window.meeting.models();
    if (models.error) throw new Error(models.error);
    try { return { modelHash: models.summary.modelHash,
      plan: await client.run('group-reconciliation', { reconciliation: input, modelHash: models.summary.modelHash }) }; }
    finally { client.dispose(); }
  }, input);
  t.diagnostic(JSON.stringify({ modelHash, fixtureHash, plan }));
  validateCandidateGroups(plan, input);
  assert.equal(await app.evaluate(() => globalThis.blockedRequests), 0);
  const actual = plan.groups.map(g => ({ kind: g.kind, candidateIds: [...g.candidateIds].sort() }))
    .sort((a, b) => a.candidateIds[0].localeCompare(b.candidateIds[0]));
  assert.deepEqual(actual, [
    { kind: 'decision', candidateIds: ['p0:i0', 'p3:i1'] },
    { kind: 'topic', candidateIds: ['p1:i0', 'p2:i0', 'p3:i0'] }
  ]);
});
