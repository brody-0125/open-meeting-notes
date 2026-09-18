import { test } from 'node:test';
import assert from 'node:assert/strict';
let Processor;
globalThis.sampleRate = 16000; globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.messages = []; this.port = { postMessage: message => this.messages.push(structuredClone(message)) }; } };
globalThis.registerProcessor = (name, value) => { assert.equal(name, 'meeting-vad'); Processor = value; };
await import('../src/audio/vad-worklet.mjs');
const send = (p, data) => p.port.onmessage({ data });
test('VAD frames preserve variable block boundaries, mono mix and sample timestamps without padding tail', () => {
  const p = new Processor(); p.process([[new Float32Array(128)]]); assert.equal(p.messages.length, 0);
  send(p, { type: 'start' });
  const signal = Float32Array.from({ length: 600 }, (_, i) => i / 600);
  let offset = 0;
  for (const length of [100, 200, 300]) {
    globalThis.currentTime = offset / 16000;
    p.process([[signal.slice(offset, offset + length), new Float32Array(length)]]); offset += length;
  }
  assert.equal(p.messages.length, 1);
  assert.deepEqual(p.messages[0].samples, signal.slice(0, 512).map(x => x / 2));
  assert.equal(p.messages[0].endTime, 512 / 16000);
  send(p, { type: 'stop' }); assert.equal(p.process([[new Float32Array(512)]]), false);
  assert.equal(p.messages.length, 1);
});
test('unacknowledged or stalled inference disables VAD rather than skipping frames as silence', () => {
  const p = new Processor(); send(p, { type: 'start' });
  for (let i = 0; i < 5; i++) p.process([[new Float32Array(512)]]);
  assert.equal(p.messages.filter(m => m.type === 'vad-frame').length, 4);
  assert.match(p.messages.at(-1).message, /backlog/);
  assert.equal(p.process([[new Float32Array(512)]]), false);
});
test('VAD only accepts matching credit acknowledgements and rejects missing or nonfinite input', () => {
  const p = new Processor(); send(p, { type: 'start' });
  p.process([[new Float32Array(512)]]); send(p, { type: 'ack', seq: 0 }); send(p, { type: 'ack', seq: 0 });
  for (let i = 0; i < 5; i++) p.process([[new Float32Array(512)]]);
  assert.equal(p.messages.filter(m => m.type === 'vad-frame').length, 5);
  for (const channels of [[], [new Float32Array([NaN])]]) {
    const broken = new Processor(); send(broken, { type: 'start' });
    assert.equal(broken.process([channels]), false); assert.equal(broken.messages[0].type, 'vad-error');
  }
});
