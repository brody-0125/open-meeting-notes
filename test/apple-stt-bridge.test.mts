import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AppleSttBridge } from '../src/electron/apple-stt-bridge.mjs';

test('mock helper probe and transcribe', async () => {
  const bridge = new AppleSttBridge({ command: 'node', args: [fileURLToPath(new URL('../scripts/apple-stt-mock-helper.mjs', import.meta.url))] });
  const probe = await bridge.probe('ko-KR');
  assert.equal(probe.ok, true);
  const audio = { jobId: 'k1', source: 'microphone', startFrame: 0, sampleRate: 16000, samples: new Float32Array(1600).fill(0.01) };
  const segments = await bridge.transcribe(audio, { locale: 'ko-KR' });
  assert.equal(segments[0].jobId, 'k1');
  assert.equal(segments[0].rawText, 'mock transcript');
});
