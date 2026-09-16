import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SilenceMonitor } from '../src/audio/silence-monitor.mjs';
import { SilencePolicy } from '../src/audio/silence.mjs';
function fixture(onState = () => {}) {
  let stops = 0;
  const monitor = new SilenceMonitor({ onState, onStop: () => stops++, policy: new SilencePolicy({ silenceMs: 100, warningMs: 50, freshnessMs: 200 }) });
  const observe = (at, speech = false) => { for (const s of ['microphone', 'remote']) monitor.observe(s, { at, speech, healthy: true }); };
  return { monitor, observe, stops: () => stops };
}
test('automatic stop requires a shown warning and fresh evidence, and fires once', () => {
  const states = [], f = fixture(s => states.push(s.type));
  f.observe(0); f.monitor.tick(100); assert.equal(f.stops(), 0);
  f.observe(150); f.monitor.tick(150); f.monitor.tick(151);
  assert.deepEqual(states, ['warning', 'warning']); assert.equal(f.stops(), 1);
});
test('speech, stale input, extension and closing cancel a pending stop', () => {
  for (const action of ['speech', 'stale', 'extend', 'close']) {
    const f = fixture(); f.observe(0); f.monitor.tick(100);
    if (action === 'speech') f.observe(150, true);
    if (action === 'extend') f.monitor.extend(150);
    if (action === 'close') f.monitor.close();
    f.monitor.tick(action === 'stale' ? 500 : 150); assert.equal(f.stops(), 0);
  }
});
test('a synchronous extension from the warning UI invalidates the stop token', () => {
  let f;
  f = fixture((_state, now) => { if (now === 150) f.monitor.extend(now); });
  f.observe(0); f.monitor.tick(100); f.observe(150); f.monitor.tick(150);
  assert.equal(f.stops(), 0);
});
