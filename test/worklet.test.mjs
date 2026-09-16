import { test } from 'node:test';
import assert from 'node:assert/strict';

let Processor;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.messages = []; this.port = { postMessage: message => this.messages.push(structuredClone(message)) }; }
};
globalThis.registerProcessor = (name, implementation) => { assert.equal(name, 'meeting-capture'); Processor = implementation; };
await import('../src/audio/capture-worklet.mjs');
const create = () => new Processor({ processorOptions: { sessionId: 'audio', source: 'microphone', chunkFrames: 4, maxPendingChunks: 2 } });
const send = (p, data) => p.port.onmessage({ data });

test('pause flushes before acknowledgment, reads no paused PCM and retains clock gap on resume', () => {
  const p = create();
  globalThis.currentFrame = 100;
  send(p, { type: 'start' });
  p.process([[Float32Array.of(1, -1)]]);
  globalThis.currentFrame = 102;
  send(p, { type: 'pause', pauseId: 1 });
  assert.deepEqual(p.messages.map(m => m.type), ['chunk', 'paused']);
  assert.deepEqual(p.messages[1], { type: 'paused', pauseId: 1, cutoff: 2 });
  assert.equal(p.process(new Proxy([], { get() { throw new Error('paused input accessed'); } })), true);
  send(p, { type: 'ack', seq: 0 });
  globalThis.currentFrame = 48102;
  send(p, { type: 'resume', pauseId: 1 });
  assert.deepEqual(p.messages.at(-1), { type: 'resumed', pauseId: 1, startFrame: 48002 });
  p.process([[Float32Array.of(.5)]]);
  send(p, { type: 'stop' });
  assert.equal(p.messages.at(-2).meta.startFrame, 48002);
  assert.equal(p.messages.at(-2).meta.seq, 1);
  assert.equal(p.messages.at(-1).cutoff, 48003);
});

test('stop during pause cannot be revived by a late resume', () => {
  const p = create(); globalThis.currentFrame = 0;
  send(p, { type: 'start' }); p.process([[Float32Array.of(1)]]);
  globalThis.currentFrame = 1; send(p, { type: 'pause', pauseId: 1 });
  send(p, { type: 'stop' });
  const count = p.messages.length;
  send(p, { type: 'resume', pauseId: 1 });
  assert.equal(p.messages.length, count);
  assert.equal(p.messages.at(-1).cutoff, 1);
  assert.equal(p.process([[Float32Array.of(1)]]), false);
});

test('stale resume and invalid pause IDs fail closed', () => {
  for (const command of [{ type: 'resume', pauseId: 2 }, { type: 'pause', pauseId: 0 }, { type: 'pause', pauseId: 1 }]) {
    const p = create(); globalThis.currentFrame = 0;
    send(p, { type: 'start' }); send(p, { type: 'pause', pauseId: 1 }); send(p, command);
    assert.equal(p.messages.at(-1).type, 'capture-error');
    assert.equal(p.process([]), false);
  }
});

test('pause cannot acknowledge a tail rejected by backpressure', () => {
  const p = create(); globalThis.currentFrame = 0;
  send(p, { type: 'start' }); p.process([[new Float32Array(9)]]);
  send(p, { type: 'pause', pauseId: 1 });
  assert.equal(p.messages.at(-1).type, 'capture-error');
  assert.equal(p.messages.some(m => m.type === 'paused'), false);
});

test('worklet waits for start, posts tail before stopped and captures nothing after stop', () => {
  const p = create();
  p.process([[new Float32Array(4)]]);
  assert.deepEqual(p.messages, []);
  send(p, { type: 'start' });
  p.process([[new Float32Array([1, 0, -1])]]);
  send(p, { type: 'stop' });
  assert.deepEqual(p.messages.map(m => m.type), ['chunk', 'stopped']);
  assert.equal(p.messages[0].meta.frames, 3);
  assert.equal(p.messages[1].cutoff, 3);
  assert.equal(p.process([[new Float32Array(4)]]), false);
  assert.equal(p.messages.length, 2);
});

test('worklet bounds outstanding messages even if renderer stops responding', () => {
  const p = create();
  send(p, { type: 'start' });
  for (let i = 0; i < 3; i++) p.process([[new Float32Array(4)]]);
  assert.deepEqual(p.messages.map(m => m.type), ['chunk', 'chunk', 'capture-error']);
  assert.match(p.messages[2].message, /queue/);
  assert.equal(p.process([[new Float32Array(4)]]), false);
});

test('only matching, once-only ACK releases worklet credit', () => {
  const p = create();
  send(p, { type: 'start' });
  p.process([[new Float32Array(4)]]);
  send(p, { type: 'ack', seq: 0 });
  send(p, { type: 'ack', seq: 0 });
  for (let i = 0; i < 3; i++) p.process([[new Float32Array(4)]]);
  assert.equal(p.messages.filter(m => m.type === 'chunk').length, 3);
  assert.equal(p.messages.at(-1).type, 'capture-error');
});

test('missing source reports capture failure rather than silent audio', () => {
  const p = create();
  send(p, { type: 'start' });
  assert.equal(p.process([[]]), false);
  assert.equal(p.messages[0].type, 'capture-error');
});
