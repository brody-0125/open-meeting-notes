import { ChunkStore } from '../src/store.mjs';
// Keep IPC referenced while paused; an unresolved Promise alone lets Node exit.
process.on('message', () => {});
const [root, target] = process.argv.slice(2);
let armed = false;
const store = new ChunkStore(root, { checkpoint: async stage => {
  if (armed && stage === target) {
    process.send({ stage });
    await new Promise(() => {});
  }
} });
const meta = { version: 1, sessionId: 'crash-test', epoch: 0, source: 'microphone', seq: 0, startFrame: 0, frames: 2, sampleRate: 48000, channels: 1 };
process.send({ ack: await store.put(meta, Buffer.from([0, 0, 1, 0])) });
armed = true;
await store.put({ ...meta, seq: 1, startFrame: 2 }, Buffer.from([2, 0, 3, 0]));
