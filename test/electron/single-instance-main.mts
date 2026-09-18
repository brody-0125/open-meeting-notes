import { startApp } from '../../src/electron/app.mjs';
startApp({ directory: process.env.OMN_APP_TEST_DIRECTORY, show: false }).then(window => {
  if (window) process.stdout.write('single-owner-ready\n');
}).catch(error => { console.error(error); process.exit(1); });
