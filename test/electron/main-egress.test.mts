import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { verifyDevelopmentPackage } from '../../src/package-integrity.mjs';

// This is an intentionally strict release gate. It uses a same-host NIC address,
// not an internet destination. It tests Main sockets independently of Chromium.
test('offline policy prevents Main native TCP egress to a verified same-host canary', { timeout: 15000 }, async t => {
  const address = Object.values(networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;
  assert.ok(address, 'same-host IPv4 interface required');
  let arrivals = 0;
  const server = createServer(socket => { arrivals++; socket.end(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: address, port });
    socket.setTimeout(2000, () => socket.destroy(new Error('control connection timeout')));
    socket.once('error', reject); socket.once('close', resolve);
  });
  assert.equal(arrivals, 1, 'positive control must reach the listener');
  const directory = await mkdtemp(join(tmpdir(), 'omn-main-egress-'));
  let app;
  if (process.env.OMN_WINDOWS_PACKAGE) {
    const root = resolve(process.env.OMN_WINDOWS_PACKAGE);
    await verifyDevelopmentPackage({ root, approvedManifestHash: process.env.OMN_PACKAGE_MANIFEST_HASH });
    app = await electron.launch({ executablePath: join(root, 'open-meeting-notes.exe'), args: [`--user-data-dir=${directory}`] });
  } else app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: directory } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.hide()));
  const result = await app.evaluate(async (_, { address, port }) => new Promise(resolve => {
    const net = process.getBuiltinModule('net');
    let connected = false, error;
    const socket = net.createConnection({ host: address, port });
    socket.once('connect', () => { connected = true; });
    socket.once('error', e => { error = e.code; });
    socket.setTimeout(2000, () => socket.destroy());
    socket.once('close', () => resolve({ connected, error }));
  }), { address, port });
  t.diagnostic(JSON.stringify({ controlArrivals: 1, mainArrivals: arrivals - 1, ...result }));
  assert.equal(arrivals, 1, 'Main must not bypass the offline boundary through a native socket');
  assert.equal(result.connected, false);
});
