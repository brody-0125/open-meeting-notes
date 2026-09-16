import { ChunkStore } from '../src/store.mjs';
import { sealRecording } from '../src/recording-seal.mjs';
process.on('message', () => {});
const [root, target] = process.argv.slice(2);
const store = new ChunkStore(root);
for (const source of ['microphone', 'remote']) await store.put({ version: 1, sessionId: 'crash', epoch: 0,
  source, seq: 0, startFrame: 0, frames: 2, sampleRate: 48000, channels: 1 }, Buffer.alloc(4));
await sealRecording({ store, sessionId: 'crash', cutoffs: { microphone: 2, remote: 2 }, checkpoint: async stage => {
  if (stage === target) { process.send({ stage }); await new Promise(() => {}); }
} });
