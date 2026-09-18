import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appleChunksToSegments } from '../inference/apple-segments.mjs';

function defaultHelperCommand() {
  const override = process.env.OMN_APPLE_STT_HELPER;
  if (override) {
    const parts = override.split(/\s+/).filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }
  const packaged = process.resourcesPath && join(process.resourcesPath, 'helpers', 'omn-speech-helper');
  if (packaged) {
    try { accessSync(packaged, fsConstants.X_OK); return { command: packaged, args: [] }; } catch { /* dev paths */ }
  }
  const macRoot = fileURLToPath(new URL('../../native/macos/omn-speech-helper', import.meta.url));
  for (const sub of ['.build/release/omn-speech-helper', '.build/debug/omn-speech-helper']) {
    const candidate = join(macRoot, sub);
    try { accessSync(candidate, fsConstants.X_OK); return { command: candidate, args: [] }; } catch { /* next */ }
  }
  return { command: join(macRoot, 'omn-speech-helper'), args: [] };
}

export class AppleSttBridge {
  constructor({ command, args } = {}) {
    const defaults = defaultHelperCommand();
    this.command = command ?? defaults.command;
    this.args = args ?? defaults.args;
  }
  async probe(locale) {
    return this.#exchange(JSON.stringify({ op: 'probe', locale }));
  }
  async transcribe(audio, { locale, preset = 'offlineTranscription', signal } = {}) {
    signal?.throwIfAborted();
    const samples = audio.samples;
    if (!(samples instanceof Float32Array) || samples.byteLength % 4 !== 0) throw new Error('invalid audio buffer');
    const header = JSON.stringify({ op: 'transcribe', id: 1, locale, preset, sampleRate: 16000, bytes: samples.byteLength });
    const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    const response = await this.#exchange(header, body, signal);
    if (!response.ok) throw new Error(response.error ?? 'apple transcription failed');
    return appleChunksToSegments(response.chunks ?? [], audio, audio.jobId);
  }
  async #exchange(headerLine, body, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const abort = () => { child.kill(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
      let stdout = Buffer.alloc(0);
      const settle = () => {
        const newline = stdout.indexOf(10);
        if (newline < 0) return;
        signal?.removeEventListener('abort', abort);
        child.kill();
        try { resolve(JSON.parse(stdout.subarray(0, newline).toString('utf8'))); }
        catch { reject(new Error(stderr || 'invalid helper response')); }
      };
      child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]); settle(); });
      child.stdin.write(`${headerLine}\n`);
      if (body) child.stdin.write(body);
      child.stdin.end();
    });
  }
}
