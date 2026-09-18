// Synthetic integrity fixture only; never a production trust anchor.
import { startApp } from '../../src/electron/app.mjs';
startApp({ directory: process.env.OMN_RESOURCE_TEST_PROFILE, show: false,
  modelConfig: { version: 1, stt: { root: process.env.OMN_RESOURCE_TEST_PACK,
    approvedManifestHash: process.env.OMN_RESOURCE_TEST_HASH, modelId: 'whisper-tiny' } }
}).catch(error => { console.error(error); process.exit(1); });
