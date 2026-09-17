import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureAppleSttReady } from '../src/electron/stt-backend.mjs';

test('apple STT readiness requires macOS', async () => {
  if (process.platform === 'darwin') return;
  await assert.rejects(ensureAppleSttReady({ backend: 'apple', locale: 'ko-KR' }, 'ko', async () => ({ ok: true, available: true, installed: true })), /macOS/);
});
