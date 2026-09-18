// Builds native/macos/omn-speech-helper when Swift toolchain is available.
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const packagePath = fileURLToPath(new URL('../native/macos/omn-speech-helper', import.meta.url));
const sources = join(packagePath, 'Sources');
const engine = join(sources, 'SpeechEngine.swift');
const live = join(packagePath, 'SpeechEngine.live.swift');

if (process.platform !== 'darwin') {
  console.error('build:apple-stt-helper requires macOS');
  process.exit(process.env.OMN_APPLE_STT_CI === '1' ? 1 : 0);
}

function macOSMajor() {
  const { stdout, status } = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
  if (status !== 0) return 0;
  return Number.parseInt(String(stdout).trim().split('.')[0], 10) || 0;
}

const major = macOSMajor();
if (major >= 26) {
  copyFileSync(live, engine);
  console.log('using SpeechEngine.live.swift for macOS', major);
} else {
  console.log('using stub SpeechEngine.swift for macOS', major);
}

const configuration = process.argv.includes('--release') ? 'release' : 'debug';
const result = spawnSync('swift', ['build', '-c', configuration, '--package-path', packagePath], { stdio: 'inherit' });
process.exit(result.status ?? 1);
