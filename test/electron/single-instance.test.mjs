import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron as electron } from 'playwright';

test('one process owns a profile; normal and forced exit release ownership without blocking other profiles', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-single-owner-'));
  const entry = fileURLToPath(new URL('./app-main.mjs', import.meta.url));
  const instances = [];
  t.after(async () => { for (const instance of instances.reverse()) await instance.close(); await rm(root, { recursive: true, force: true }); });
  const launch = async profile => {
    const instance = await electron.launch({ args: [entry], env: { ...process.env, OMN_APP_TEST_DIRECTORY: join(root, profile) } });
    instances.push(instance); await instance.firstWindow(); return instance;
  };
  const first = await launch('first');
  const duplicate = spawn(executablePath, [entry], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: join(root, 'first'), ELECTRON_RUN_AS_NODE: undefined } });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { duplicate.kill(); reject(new Error('duplicate profile process did not exit')); }, 5000);
    duplicate.once('error', error => { clearTimeout(timer); reject(error); });
    duplicate.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(await first.evaluate(({ app }) => app.hasSingleInstanceLock()), true);
  assert.equal(await (await first.firstWindow()).getByRole('button', { name: '녹음 준비', exact: true }).count(), 1);
  const other = await launch('other');
  assert.equal(await other.evaluate(({ app }) => app.hasSingleInstanceLock()), true);
  await first.close(); instances.splice(instances.indexOf(first), 1);
  const reopened = await launch('first');
  assert.equal(await reopened.evaluate(({ app }) => app.hasSingleInstanceLock()), true);
  await reopened.close(); instances.splice(instances.indexOf(reopened), 1);
  const crashedProcess = spawn(executablePath, [fileURLToPath(new URL('./single-instance-main.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: join(root, 'first'), ELECTRON_RUN_AS_NODE: undefined }
  });
  t.after(() => { if (crashedProcess.exitCode === null && crashedProcess.signalCode === null) crashedProcess.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { crashedProcess.kill(); reject(new Error('crash fixture did not start')); }, 5000);
    let output = '';
    crashedProcess.stdout.on('data', bytes => { output += bytes; if (output.includes('single-owner-ready')) { clearTimeout(timer); resolve(); } });
    crashedProcess.once('error', error => { clearTimeout(timer); reject(error); });
    crashedProcess.once('exit', () => { clearTimeout(timer); reject(new Error('crash fixture exited before readiness')); });
  });
  await new Promise((resolve, reject) => {
    crashedProcess.once('exit', resolve);
    if (!crashedProcess.kill('SIGKILL')) reject(new Error('test process could not be terminated'));
  });
  const afterCrash = await launch('first');
  assert.equal(await afterCrash.evaluate(({ app }) => app.hasSingleInstanceLock()), true);
  assert.equal(await other.evaluate(({ app }) => app.hasSingleInstanceLock()), true);
});
