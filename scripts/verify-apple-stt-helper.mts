// Smoke-test built helper: probe + silent transcribe framing (macOS only).
import { spawnSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('verify-apple-stt-helper requires macOS');
  process.exit(1);
}

function macOSMajor() {
  const { stdout, status } = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
  if (status !== 0) return 0;
  return Number.parseInt(String(stdout).trim().split('.')[0], 10) || 0;
}

function exchange(helper, payload) {
  const child = spawnSync(helper, [], { input: payload, maxBuffer: 16 * 1024 * 1024 });
  if (child.status !== 0) {
    console.error(child.stderr?.toString() || child.stdout?.toString());
    process.exit(child.status ?? 1);
  }
  const line = child.stdout.toString('utf8').trim().split('\n')[0];
  return JSON.parse(line);
}

const root = fileURLToPath(new URL('../native/macos/omn-speech-helper', import.meta.url));
const helper = [join(root, '.build/release/omn-speech-helper'), join(root, '.build/debug/omn-speech-helper')]
  .find(path => { try { accessSync(path); return true; } catch { return false; } });
if (!helper) {
  console.error('omn-speech-helper binary not found; run npm run build:apple-stt-helper');
  process.exit(1);
}

const probe = exchange(helper, Buffer.from('{"op":"probe","locale":"ko-KR"}\n'));
if (!probe.ok) {
  console.error('probe failed', probe);
  process.exit(1);
}

const major = macOSMajor();
const strict = process.env.OMN_APPLE_STT_STRICT === '1';
if (strict && !probe.available) {
  console.error('probe unavailable on macOS', major, probe);
  process.exit(1);
}

const bytes = 1600;
const header = JSON.stringify({ op: 'transcribe', id: 1, locale: 'ko-KR', preset: 'offlineTranscription', sampleRate: 16000, bytes });
const silent = Buffer.alloc(bytes);
const transcribe = exchange(helper, Buffer.concat([Buffer.from(`${header}\n`), silent]));

if (!transcribe.ok) {
  if (major < 26) {
    console.log(JSON.stringify({ helper, major, probe, transcribe: 'skipped-below-26' }));
    process.exit(0);
  }
  if (!strict) {
    console.warn('transcribe failed on macOS 26+ (locale model or permissions may be missing in CI)', transcribe);
    console.log(JSON.stringify({ helper, major, probe, transcribe }));
    process.exit(0);
  }
  console.error('transcribe failed', transcribe);
  process.exit(1);
}
if (!Array.isArray(transcribe.chunks)) {
  console.error('invalid transcribe response', transcribe);
  process.exit(1);
}

console.log(JSON.stringify({ helper, major, probe: { available: probe.available, installed: probe.installed }, transcribeChunks: transcribe.chunks.length }));
