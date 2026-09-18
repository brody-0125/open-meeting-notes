import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceClient } from '../src/inference/client.mjs';
function fixture() {
  const workers = [];
  const client = new InferenceClient(() => {
    const worker = { messages: [], terminated: false, postMessage(m) { this.messages.push(m); }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  });
  return { client, workers };
}
const reply = (worker, result) => worker.onmessage({ data: { id: worker.messages.at(-1).id, type: 'result', result } });

test('input and output limits preserve a healthy worker; unknown errors still terminate it', async () => {
  for (const code of ['OUTPUT_LIMIT', 'CONTEXT_LIMIT', 'unknown']) {
    const known = code !== 'unknown';
    const { client, workers } = fixture();
    const pending = client.run('reconcile', {});
    workers[0].onmessage({ data: { id: workers[0].messages[0].id, type: 'error', message: 'failed', code } });
    await assert.rejects(pending, error => known ? error.code === code : error.code === undefined);
    assert.equal(workers[0].terminated, !known);
    if (known) {
      const retry = client.run('reconcile', {});
      reply(workers[0], 'smaller request'); assert.equal(await retry, 'smaller request');
      assert.equal(workers.length, 1);
    }
    client.dispose();
  }
});
test('one active inference job; idle worker reused', async () => {
  const { client, workers } = fixture();
  const first = client.run('transcribe', {});
  await assert.rejects(client.run('summarize', {}), /busy/);
  reply(workers[0], ['first']); assert.deepEqual(await first, ['first']);
  const second = client.run('summarize', {});
  reply(workers[0], 'second'); assert.equal(await second, 'second');
  const third = client.run('reconcile', { reconciliation: { revision: 3 } });
  reply(workers[0], 'third'); assert.equal(await third, 'third');
  assert.equal(workers[0].messages.at(-1).operation, 'reconcile');
  assert.equal(workers.length, 1); client.dispose();
});
test('abort terminates computation; late result cannot settle the next job', async () => {
  const { client, workers } = fixture();
  const signal = new AbortController();
  const first = client.run('transcribe', {}, { signal: signal.signal });
  const lateHandler = workers[0].onmessage;
  signal.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(workers[0].terminated, true);
  const second = client.run('transcribe', {});
  lateHandler({ data: { id: workers[0].messages[0].id, type: 'result', result: 'stale' } });
  reply(workers[1], 'current'); assert.equal(await second, 'current'); client.dispose();
});
test('worker crash rejects job and next request gets fresh worker', async () => {
  const { client, workers } = fixture();
  const first = client.run('summarize', {});
  workers[0].onerror({ message: 'device lost', preventDefault() {} });
  await assert.rejects(first, /device lost/);
  const second = client.run('summarize', {});
  reply(workers[1], 'ok'); assert.equal(await second, 'ok'); client.dispose();
});
test('already aborted requests never create a worker', async () => {
  const { client, workers } = fixture();
  await assert.rejects(client.run('transcribe', {}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(workers.length, 0);
});
test('dispose rejects an active request and permanently closes client', async () => {
  const { client } = fixture();
  const request = client.run('transcribe', {});
  client.dispose();
  await assert.rejects(request, /disposed/);
  await assert.rejects(client.run('transcribe', {}), /disposed/);
});

test('VAD preloads in its client, bounds outstanding frames and cancels stale probability results', async () => {
  const { client, workers } = fixture();
  const ready = client.run('vad-load', {}); reply(workers[0], { ready: true }); await ready;
  const controller = new AbortController();
  const pending = client.run('vad', { source: 'microphone', samples: new Float32Array(512) }, { signal: controller.signal });
  await assert.rejects(client.run('vad', { source: 'remote' }), /busy/);
  const stale = workers[0].onmessage, oldId = workers[0].messages.at(-1).id;
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  const retry = client.run('vad-load', {});
  stale({ data: { id: oldId, type: 'result', result: { probability: 0, speech: false } } });
  reply(workers[1], { ready: true }); assert.deepEqual(await retry, { ready: true }); client.dispose();
});
