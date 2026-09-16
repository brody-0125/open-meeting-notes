import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApp } from '../../src/electron/app.mjs';
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const root = process.env.OMN_VAD_FIXTURE;
const approval = JSON.parse(await readFile(join(root, 'fixture-approval.json'), 'utf8'));
globalThis.blockedRequests = 0;
startApp({ directory: process.env.OMN_APP_TEST_DIRECTORY, show: false, confirm: async () => true,
  modelConfig: { version: 1, vad: { root, approvedManifestHash: approval.manifestHash } },
  onBlockedRequest: () => { globalThis.blockedRequests++; }
}).catch(error => { console.error(error); process.exit(1); });
