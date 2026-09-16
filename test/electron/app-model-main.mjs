// Test-only approvals are not production installation trust anchors.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApp } from '../../src/electron/app.mjs';
import { ChunkStore } from '../../src/store.mjs';
globalThis.testChunkStore = ChunkStore;
const modelConfig = { version: 1 };
for (const [kind, variable] of [['stt', 'OMN_STT_FIXTURE'], ['summary', 'OMN_SUMMARY_FIXTURE']]) {
  const root = process.env[variable];
  const approval = JSON.parse(await readFile(join(root, 'fixture-approval.json'), 'utf8'));
  modelConfig[kind] = { root, approvedManifestHash: approval.manifestHash, ...(kind === 'stt' ? { modelId: approval.modelId ?? 'whisper-tiny' } : {}) };
}
globalThis.blockedRequests = 0;
if (process.env.OMN_VAD_FIXTURE) {
  const root = process.env.OMN_VAD_FIXTURE;
  const approval = JSON.parse(await readFile(join(root, 'fixture-approval.json'), 'utf8'));
  modelConfig.vad = { root, approvedManifestHash: approval.manifestHash };
}
startApp({ directory: process.env.OMN_APP_TEST_DIRECTORY, show: false, modelConfig,
  onBlockedRequest: () => { globalThis.blockedRequests++; }
}).catch(error => { console.error(error); process.exit(1); });
