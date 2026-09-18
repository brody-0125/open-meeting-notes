import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { verifyDevelopmentPackage } from '../../src/package-integrity.mjs';

// Only this host's interface, no external host, DNS lookup, microphone or meeting data.
async function probe({ address, port, transport }) {
  const host = address.includes(':') ? `[${address}]` : address;
  const server = transport === 'udp' ? { urls: `stun:${host}:${port}` }
    : { urls: `${transport === 'tls' ? 'turns' : 'turn'}:${host}:${port}?transport=tcp`, username: 'synthetic', credential: 'synthetic' };
  const connection = new RTCPeerConnection({ iceServers: [server] });
  let candidates = 0;
  connection.onicecandidate = event => { if (event.candidate) candidates++; };
  try {
    connection.createDataChannel('synthetic-probe');
    await connection.setLocalDescription(await connection.createOffer());
    await new Promise(resolve => setTimeout(resolve, 2500));
    return { candidates, state: connection.iceGatheringState };
  } finally { connection.close(); }
}

for (const [family, transport] of [['IPv4', 'udp'], ['IPv4', 'tcp'], ['IPv4', 'tls'], ['IPv6', 'tcp'], ['IPv6', 'tls']]) test(`app policy prevents WebRTC ${family}/${transport} egress to a live same-host canary`, { timeout: 30000 }, async t => {
  const interfaces = Object.values(networkInterfaces()).flat();
  const address = family === 'IPv6' ? interfaces.find(i => i.family === 'IPv6' && !i.internal && !i.address.startsWith('fe80:'))?.address ?? '::1'
    : interfaces.find(i => i.family === 'IPv4' && !i.internal)?.address;
  assert.ok(address, 'same-host IPv4 interface required for the positive control');
  const root = await mkdtemp(join(tmpdir(), 'omn-egress-'));
  let packets = 0, app;
  const socket = transport === 'udp' ? createSocket('udp4') : createServer(client => { packets++; client.destroy(); });
  if (transport === 'udp') socket.on('message', bytes => {
    if (bytes.length >= 20 && bytes.readUInt32BE(4) === 0x2112a442) packets++;
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    if (transport === 'udp') socket.bind(0, address, resolve); else socket.listen(0, address, resolve);
  });
  t.after(async () => { socket.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  const port = socket.address().port;
  if (process.env.OMN_WINDOWS_PACKAGE) {
    const install = resolve(process.env.OMN_WINDOWS_PACKAGE);
    await verifyDevelopmentPackage({ root: install, approvedManifestHash: process.env.OMN_PACKAGE_MANIFEST_HASH });
    app = await electron.launch({ executablePath: join(install, 'open-meeting-notes.exe'), args: [`--user-data-dir=${root}`] });
  } else app = await electron.launch({ args: [fileURLToPath(new URL('./app-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: root } });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.hide()));
  const proxies = await app.evaluate(async ({ session }) => Promise.all(
    ['https://example.invalid/', 'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/'].map(url => session.defaultSession.resolveProxy(url))));
  for (const proxy of proxies) assert.match(proxy, /^PROXY 127\.0\.0\.1:\d+$/, 'no DIRECT fallback or implicit loopback bypass');
  const controlApp = await electron.launch({ args: [fileURLToPath(new URL('./network-control-main.mjs', import.meta.url))],
    env: { ...process.env, OMN_APP_TEST_DIRECTORY: join(root, 'control') } });
  let control;
  try { control = await (await controlApp.firstWindow()).evaluate(probe, { address, port, transport }); }
  finally { await controlApp.close(); }
  t.diagnostic(JSON.stringify({ controlPackets: packets, control }));
  assert.ok(packets > 0, 'unrestricted control must reach the canary to prove detection');
  const controlPackets = packets; packets = 0;
  const result = await page.evaluate(probe, { address, port, transport });
  t.diagnostic(JSON.stringify({ transport, controlHits: controlPackets, control, appHits: packets, result }));
  assert.equal(packets, 0, 'application must not contact STUN/TURN outside omn:// resources');
  if (transport !== 'udp') {
    // Simulate an unavailable proxy using a freshly closed local listener.
    // Keep the product's fixed-proxy configuration, replacing only its endpoint.
    const unavailable = createServer();
    await new Promise(resolve => unavailable.listen(0, '127.0.0.1', resolve));
    const unavailablePort = unavailable.address().port;
    await new Promise(resolve => unavailable.close(resolve));
    await app.evaluate(async ({ session }, port) => {
      await session.defaultSession.setProxy({ mode: 'fixed_servers',
        proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
      await session.defaultSession.closeAllConnections();
    }, unavailablePort);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.evaluate(probe, { address, port, transport });
      assert.equal(packets, 0, 'failed proxy must not fall back to a direct TURN connection');
    }
    assert.equal(await page.evaluate(async () => (await fetch('/app.mjs')).status), 200);
    t.diagnostic(JSON.stringify({ transport, unavailableProxyAttempts: 2, appHits: packets, localResourceStatus: 200 }));
  }
});
