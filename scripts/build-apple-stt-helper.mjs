// Builds native/macos/omn-speech-helper when Swift toolchain is available.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const packagePath = fileURLToPath(new URL('../native/macos/omn-speech-helper', import.meta.url));
if (process.platform !== 'darwin') {
  console.error('build:apple-stt-helper requires macOS');
  process.exit(process.env.OMN_APPLE_STT_CI === '1' ? 1 : 0);
}
const configuration = process.argv.includes('--release') ? 'release' : 'debug';
const result = spawnSync('swift', ['build', '-c', configuration, '--package-path', packagePath], { stdio: 'inherit' });
process.exit(result.status ?? 1);
