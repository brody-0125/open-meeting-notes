import { JobStore, runJob } from '../src/jobs.mjs';
process.on('message', () => {});
let armed = false;
const store = new JobStore(process.argv[2], { checkpoint: async stage => {
  if (armed && stage === 'synced') { process.send({ stage }); await new Promise(() => {}); }
} });
const job = { version: 1, sessionId: 'crash', kind: 'transcribe', revision: 1, inputHash: '1'.repeat(64), modelHash: '2'.repeat(64), settingsHash: '3'.repeat(64) };
await runJob(store, job, async () => ({ text: 'acknowledged' }), () => {});
process.send({ committed: job });
armed = true;
await runJob(store, { ...job, inputHash: '4'.repeat(64) }, async () => ({ text: 'unacknowledged' }), () => {});
