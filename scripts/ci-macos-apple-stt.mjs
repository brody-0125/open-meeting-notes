// macOS CI entry: build helper, protocol smoke, deployment tests. Fails on non-macOS.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'darwin') {
  console.error('ci:macos-apple-stt requires a macOS runner');
  process.exit(1);
}

function run(command, args, { env } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;

// Run before building the helper so the "rejects apple STT without helper" test sees no binary.
run(node, ['--test', join(root, 'test/deployment/macos-package-config.test.mjs')]);
run(node, [join(root, 'scripts/build-apple-stt-helper.mjs'), '--release']);
run(node, [join(root, 'scripts/verify-apple-stt-helper.mjs')]);
run(node, ['--test',
  join(root, 'test/apple-stt-bridge.test.mjs'),
  join(root, 'test/apple-stt-example.test.mjs'),
  join(root, 'test/stt-capability.test.mjs'),
  join(root, 'test/stt-backend.test.mjs'),
  join(root, 'test/stt-settings.test.mjs'),
  join(root, 'test/apple-segments.test.mjs')]);

console.log('ci:macos-apple-stt complete');
