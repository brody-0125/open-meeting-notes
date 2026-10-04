import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSummaries, validateVerdict } from '../tools/summary-judge.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('summary judge fails closed on missing criteria, fabricated evidence, malformed output and hallucinations', () => {
  const criteria = { budget: '예산 미승인' }, candidate = '예산 미승인. 금요일 출시.';
  const good = { checks: { budget: { verdict: 'supported', quote: '예산 미승인' } }, hallucinations: [], warnings: [] };
  assert.equal(validateVerdict(good, criteria, candidate), true);
  assert.equal(validateVerdict({ ...good, warnings: [{ quote: '예산 미승인', reason: '표기 경고' }] }, criteria, candidate), true);
  assert.equal(validateVerdict({ ...good, hallucinations: ['금요일 출시.'] }, criteria, candidate), false);
  assert.equal(validateVerdict({ ...good, checks: { budget: { verdict: 'missing', quote: '' } } }, criteria, candidate), false);
  for (const value of [null, {}, { ...good, checks: {} }, { ...good, hallucinations: ['없는 문장'] },
    { ...good, checks: { budget: { verdict: 'supported', quote: '' } } },
    { ...good, checks: { budget: { verdict: 'supported', quote: '정답에서 복사한 근거' } } },
    { ...good, checks: { budget: { verdict: 'maybe', quote: '예산 미승인' } } },
    { ...good, checks: { budget: { verdict: 'contradicted', quote: '' } } },
    { ...good, warnings: [{ quote: '없는 경고', reason: '설명' }] },
    { ...good, warnings: [{ quote: '예산 미승인', reason: '' }] }]) {
    assert.throws(() => validateVerdict(value, criteria, candidate), /invalid/);
  }
});

test('standalone judge CLI works outside the repo, preserves runs and fails closed without a hosted call', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-judge-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'fake codex.cjs');
  await writeFile(binary, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('test-cli'); process.exit(0); }
if (!args.includes('--ignore-user-config') || !args.includes('--ephemeral') || args[args.indexOf('--sandbox') + 1] !== 'read-only') process.exit(9);
const mode = args[args.indexOf('--model') + 1];
if (mode === 'timeout') { setInterval(() => {}, 1000); } else {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').split('\\n').at(-1));
  const output = Object.fromEntries(Object.entries(input.candidates).map(([id, text]) => [id, {
    checks: Object.fromEntries(Object.keys(input.criteria).map(key => [key, { verdict: mode === 'reject' ? 'missing' : 'supported', quote: mode === 'reject' ? '' : mode === 'invalid' ? 'fabricated' : text }])),
    hallucinations: [], warnings: []
  }]));
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(output));
  if (mode === 'tool') console.log(JSON.stringify({ item: { type: 'command_execution' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}`);
  const input = { sourceText: '예산 승인 보류.', criteria: { budget: '승인 보류' }, candidates: ['예산 승인 보류.'] };
  await writeFile(join(root, 'input.json'), JSON.stringify(input));
  const tool = fileURLToPath(new URL('../tools/summary-judge.mjs', import.meta.url));
  const run = model => spawnSync(process.execPath, [tool, '--input', 'input.json', '--output', 'results',
    '--bin', binary, '--model', model], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const first = run('pass'); assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.passed, true); assert.equal(report.model, 'pass'); assert.equal(report.cliVersion, 'test-cli');
  assert.deepEqual(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8')), report);
  const second = run('reject'); assert.equal(second.status, 1, second.stderr);
  assert.notEqual(JSON.parse(second.stdout).directory, report.directory);
  assert.equal(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8')).passed, true);
  for (const mode of ['invalid', 'tool']) {
    const failed = run(mode); assert.equal(failed.status, 2, failed.stderr);
    assert.match(failed.stderr, /invalid judge evidence|judge used a tool/);
  }
  await assert.rejects(judgeSummaries(input.criteria, input.candidates, root, input.sourceText,
    { binary, model: 'timeout', timeoutMs: 50 }), /ETIMEDOUT/);
  await assert.rejects(judgeSummaries({}, input.candidates, root, input.sourceText, { binary }), /required/);
  const help = spawnSync(process.execPath, [tool, '--help'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0); assert.match(help.stdout, /Exit codes/);
});
