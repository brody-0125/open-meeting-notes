import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapturePermissions, installCapturePermissions } from '../src/electron/permissions.mjs';
import { EventEmitter } from 'node:events';
import { APP_URL } from '../src/electron/policy.mjs';

function fixture() {
  let now = 0;
  const mainFrame = { url: APP_URL }, contents = { mainFrame };
  const window = { webContents: contents, isDestroyed: () => false };
  const gate = new CapturePermissions(window, { now: () => now, lifetimeMs: 100 });
  const event = { sender: contents, senderFrame: mainFrame };
  const details = { isMainFrame: true, requestingUrl: APP_URL, securityOrigin: 'omn://app', mediaType: 'audio', mediaTypes: ['audio'] };
  return { gate, event, contents, window, details, time: n => { now = n; } };
}

test('permission is denied until armed and after expiration/revocation', () => {
  const f = fixture();
  const check = () => f.gate.check(f.contents, 'media', 'omn://app', f.details);
  assert.equal(check(), false);
  f.gate.arm(f.event);
  assert.equal(check(), true);
  f.time(100);
  assert.equal(check(), false);
  f.gate.arm(f.event);
  assert.equal(check(), true);
  f.gate.revoke();
  assert.equal(check(), false);
});

test('only exact app main frame may arm and request audio permission', () => {
  const f = fixture();
  assert.throws(() => f.gate.arm({ ...f.event, senderFrame: { url: APP_URL } }), /untrusted/);
  f.gate.arm(f.event);
  assert.equal(f.gate.request(f.contents, 'media', f.details), true);
  assert.equal(f.gate.request(f.contents, 'media', { ...f.details, mediaTypes: [] }), true);
  for (const details of [undefined, { ...f.details, isMainFrame: false }, { ...f.details, requestingUrl: 'omn://app/other.html' },
    { ...f.details, securityOrigin: 'https://app' }, { ...f.details, mediaTypes: ['audio', 'video'] }, { ...f.details, mediaTypes: ['video'] }]) {
    assert.equal(f.gate.request(f.contents, 'media', details), false);
  }
  assert.equal(f.gate.request({}, 'media', f.details), false);
  for (const permission of ['notifications', 'geolocation', 'clipboard-read', 'unknown']) {
    assert.equal(f.gate.request(f.contents, permission, f.details), false);
  }
  assert.equal(f.gate.check(f.contents, 'media', 'omn://app', { ...f.details, mediaType: 'video' }), false);
  assert.equal(f.gate.check(f.contents, 'media', 'omn://app.evil', f.details), false);
});

test('display capture also requires the approved frame and active user gesture', () => {
  const f = fixture();
  const request = { frame: f.contents.mainFrame, securityOrigin: 'omn://app', audioRequested: true, videoRequested: true, userGesture: true };
  assert.equal(f.gate.display(request), false);
  f.gate.arm(f.event);
  assert.equal(f.gate.display(request), true);
  for (const change of [{ frame: null }, { frame: { url: APP_URL } }, { securityOrigin: 'https://app' }, { userGesture: false }, { audioRequested: false }]) {
    assert.equal(f.gate.display({ ...request, ...change }), false);
  }
  f.contents.mainFrame.url = 'https://example.invalid';
  assert.equal(f.gate.display(request), false);
});

test('destroyed or replaced approved window/frame cannot reuse the grant', () => {
  const f = fixture();
  f.gate.arm(f.event);
  f.contents.mainFrame = { url: APP_URL };
  assert.equal(f.gate.request(f.contents, 'media', f.details), false);
  f.gate.arm({ sender: f.contents, senderFrame: f.contents.mainFrame });
  f.window.isDestroyed = () => true;
  assert.equal(f.gate.request(f.contents, 'media', f.details), false);
});

test('installed handlers revoke on navigation/crash and never auto-select display sources', () => {
  const f = fixture();
  Object.setPrototypeOf(f.contents, EventEmitter.prototype);
  EventEmitter.call(f.contents);
  const handlers = {};
  const gate = installCapturePermissions({
    setPermissionCheckHandler: fn => { handlers.check = fn; },
    setPermissionRequestHandler: fn => { handlers.request = fn; },
    setDisplayMediaRequestHandler: fn => { handlers.display = fn; }
  }, f.window);
  for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
    gate.arm(f.event);
    assert.equal(handlers.check(f.contents, 'media', 'omn://app', f.details), true);
    f.contents.emit(event, {}, APP_URL, false, true);
    let allowed;
    handlers.request(f.contents, 'media', result => { allowed = result; }, f.details);
    assert.equal(allowed, false);
  }
  gate.arm(f.event);
  let selection;
  handlers.display({}, result => { selection = result; });
  assert.deepEqual(selection, {});
});
