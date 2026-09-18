import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_URL, assertSender, isLocalResource } from '../src/electron/policy.mjs';
test('C11 rejects remote origins, credentials and look-alike hosts', () => {
  assert.equal(isLocalResource(APP_URL), true);
  for (const url of ['https://app/', 'omn://app.evil/', 'omn://user@app/', 'omn://app:80/', 'file:///secret', 'http://localhost/', 'junk']) assert.equal(isLocalResource(url), false);
});
test('C11 requires the exact window, main frame and document', () => {
  const frame = { url: APP_URL }, contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  const valid = { sender: contents, senderFrame: frame };
  assert.doesNotThrow(() => assertSender(valid, window));
  assert.throws(() => assertSender({ ...valid, sender: {} }, window));
  assert.throws(() => assertSender({ ...valid, senderFrame: { url: APP_URL } }, window));
  frame.url = 'https://example.invalid/';
  assert.throws(() => assertSender(valid, window));
});
