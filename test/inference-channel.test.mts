import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceChannel } from '../src/electron/inference-channel.mjs';

test('known input and output limit codes survive IPC, unknown codes cannot authorize recovery', async () => {
  for (const code of ['OUTPUT_LIMIT', 'CONTEXT_LIMIT', 'arbitrary']) {
    let message;
    const channel = new InferenceChannel(value => { message = value; });
    const pending = channel.request('reconcile', {});
    channel.respond({ id: message.id, error: 'generation failed', errorCode: code });
    await assert.rejects(pending, error => code !== 'arbitrary' ? error.code === code : error.code === undefined);
  }
});
test('only the current request accepts a result', async () => {
  const sent = [];
  const channel = new InferenceChannel(message => sent.push(message));
  const first = channel.request('transcribe', {});
  assert.equal(channel.respond({ id: 'wrong', result: [] }), false);
  await assert.rejects(channel.request('summarize', {}), /busy/);
  assert.equal(channel.respond({ id: sent[0].id, result: ['ok'] }), true);
  assert.deepEqual(await first, ['ok']);
  assert.equal(channel.respond({ id: sent[0].id, result: ['late'] }), false);
});
test('abort releases the waiter and rejects late results', async () => {
  let message;
  const channel = new InferenceChannel(value => { message = value; });
  const controller = new AbortController();
  const pending = channel.request('transcribe', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(channel.respond({ id: message.id, result: [] }), false);
});
test('missing renderer response times out instead of blocking forever', async () => {
  const channel = new InferenceChannel(() => {}, { timeoutMs: 20 });
  await assert.rejects(channel.request('transcribe', {}), /timeout/);
});
