import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayPicker, installWindowsDisplayPicker } from '../src/electron/display-picker.mjs';
import { CapturePermissions } from '../src/electron/permissions.mjs';
import { APP_URL } from '../src/electron/policy.mjs';

function setup(options = {}) {
  const frame = { url: APP_URL }, contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  const gate = new CapturePermissions(window);
  const event = { sender: contents, senderFrame: frame };
  gate.arm(event);
  const request = { frame, securityOrigin: 'omn://app', audioRequested: true, videoRequested: true, userGesture: true };
  const sources = [{ id: 'screen:1:0', name: 'Screen 1' }, { id: 'screen:2:0', name: 'Screen 2' }];
  const handler = createDisplayPicker({ gate, platform: 'win32', enumerate: async () => sources,
    choose: async () => sources[1].id, ...options });
  return { gate, event, request, handler, sources };
}
const invoke = (f, request = f.request) => new Promise(resolve => f.handler(request, resolve));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only explicit selection returns a current source and system loopback', async () => {
  const f = setup();
  assert.deepEqual(await invoke(f), { video: f.sources[1], audio: 'loopback' });
});
test('cancellation, unknown selection and unavailable source return no streams', async () => {
  for (const selection of [null, 'screen:unknown:0']) {
    const f = setup({ choose: async () => selection });
    assert.deepEqual(await invoke(f), {});
  }
  let calls = 0;
  const f = setup({ enumerate: async () => ++calls === 1 ? [{ id: 'screen:2:0' }] : [] });
  assert.deepEqual(await invoke(f), {});
});
test('revoking and rearming while dialog is open cannot reuse an old choice', async () => {
  let choose;
  const f = setup({ choose: () => new Promise(resolve => { choose = resolve; }) });
  const result = invoke(f);
  await tick();
  f.gate.revoke(); f.gate.arm(f.event);
  choose('screen:2:0');
  assert.deepEqual(await result, {});
});
test('concurrent request is denied and timed-out choice never invokes callback twice', async () => {
  let choose;
  const f = setup({ timeoutMs: 20, choose: () => new Promise(resolve => { choose = resolve; }) });
  const results = [];
  f.handler(f.request, result => results.push(result));
  await tick();
  assert.deepEqual(await invoke(f), {});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(results, [{}]);
  choose('screen:2:0');
  await tick();
  assert.deepEqual(results, [{}]);
});
test('unauthorized requests and unsupported platform never enumerate sources', async () => {
  let calls = 0;
  const f = setup({ enumerate: async () => { calls++; return []; } });
  f.gate.revoke();
  assert.deepEqual(await invoke(f), {});
  const other = setup({ platform: 'darwin', enumerate: async () => { calls++; return []; } });
  assert.deepEqual(await invoke(other), {});
  assert.equal(calls, 0);
});

test('native adapter enumerates only on request and makes capture scope explicit', async () => {
  const f = setup();
  let handler, options, enumerations = 0;
  const owner = {};
  installWindowsDisplayPicker({ gate: f.gate, window: owner, platform: 'win32',
    session: { setDisplayMediaRequestHandler: fn => { handler = fn; } },
    desktopCapturer: { getSources: async config => {
      assert.deepEqual(config.thumbnailSize, { width: 0, height: 0 });
      enumerations++; return f.sources;
    } },
    dialog: { showMessageBox: async (window, config) => {
      assert.equal(window, owner); options = config; return { response: 2 };
    } }
  });
  assert.equal(enumerations, 0);
  const result = await new Promise(resolve => handler(f.request, resolve));
  assert.equal(result.video.id, 'screen:2:0');
  assert.equal(enumerations, 2);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.match(options.detail, /전체 시스템 소리/);
  assert.equal(options.signal.aborted, true);
});
