import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installInferenceDouble } from '../tools/testing/inference-double.mjs';
import { InferenceClient } from '../src/inference/client.mjs';

test('integration inference double copies messages, fails closed and drops terminated computations', { timeout: 5000 }, async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const context = { structuredClone, setTimeout, clearTimeout, inferenceHandlers: {
    transcribe: async input => { entered(input); return new Promise(resolve => { release = resolve; }); },
    summarize: () => { throw Object.assign(new Error('output exhausted'), { code: 'OUTPUT_LIMIT' }); }
  } };
  runInNewContext(`(${installInferenceDouble.toString()})()`, context);
  const makeWorker = () => new context.Worker('omn://app/inference-worker.mjs', { type: 'module' });
  const client = new InferenceClient(makeWorker);
  try {
    const input = { samples: new Float32Array([.25]) }, abort = new AbortController();
    const pending = client.run('transcribe', input, { signal: abort.signal });
    input.samples[0] = .75;
    assert.equal(release, undefined, 'handler must not run in the postMessage call');
    assert.equal((await started).samples[0], .25);
    const worker = context.inferenceDouble.workers[0];
    let delivered = false; worker.onmessage = () => { delivered = true; };
    abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
    release(['late']); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(delivered, false);
    await assert.rejects(client.run('summarize', {}), { code: 'OUTPUT_LIMIT' });
    assert.equal(context.inferenceDouble.workers[1].terminated, false);
    await assert.rejects(client.run('plan-summary', {}), /unexpected inference request/);
    assert.equal(context.inferenceDouble.unexpected.length, 1);
    const output = { values: [1] };
    context.inferenceHandlers.transcribe = () => output;
    const result = await client.run('transcribe', {});
    output.values[0] = 2;
    assert.equal(result.values[0], 1);
  } finally { client.dispose(); context.inferenceDouble.restore(); }
  assert.equal(context.Worker, undefined);
  assert.equal(context.inferenceDouble, undefined);
  context.options = { handlers: {}, workerUrl: 'https://test.invalid/worker.js', errorCodes: ['LIMIT'] };
  runInNewContext(`(${installInferenceDouble.toString()})(options)`, context);
  assert.throws(() => makeWorker(), /unexpected worker/);
  const worker = new context.Worker(context.options.workerUrl, { type: 'module' });
  context.inferenceDouble.restore();
  assert.equal(worker.terminated, true);
});
