import { startApp } from '../../src/electron/app.mjs';
import { ChunkStore } from '../../src/store.mjs';
import { PauseStore } from '../../src/pauses.mjs';
globalThis.testChunkStore = ChunkStore;
globalThis.testPauseStore = PauseStore;
startApp({ directory: process.env.OMN_APP_TEST_DIRECTORY, show: false,
  confirm: async () => globalThis.testConfirm ? globalThis.testConfirm() : true
}).catch(error => { console.error(error); process.exit(1); });
