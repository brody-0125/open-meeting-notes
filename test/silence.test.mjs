import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SilencePolicy } from '../src/audio/silence.mjs';
const create = () => new SilencePolicy({ silenceMs: 100, warningMs: 30, freshnessMs: 25 });
function silent(p, from, to) { for (let at = from; at <= to; at += 10) for (const source of ['microphone', 'remote']) p.observe(source, { at, speech: false, healthy: true }); }
test('continuous healthy silence on both sources requires warning before stop', () => {
  const p = create(); silent(p, 0, 100);
  const warning = p.evaluate(100);
  assert.equal(warning.type, 'warning'); assert.equal(warning.deadline, 130);
  assert.equal(p.confirm(warning.token, 120), false);
  silent(p, 110, 130);
  assert.equal(p.confirm(warning.token, 130), true);
  assert.equal(p.confirm(warning.token, 130), false);
});
test('speech from either source invalidates scheduled warning callback', () => {
  const p = create(); silent(p, 0, 100); const warning = p.evaluate(100);
  p.observe('remote', { at: 110, speech: true, healthy: true });
  silent(p, 120, 140);
  assert.equal(p.confirm(warning.token, 140), false);
  assert.equal(p.evaluate(140).type, 'listening');
});
test('missing, stale and unhealthy input never counts as silence', () => {
  const p = create();
  p.observe('microphone', { at: 0, speech: false, healthy: true });
  assert.equal(p.evaluate(0).type, 'disabled');
  silent(p, 10, 110); const warning = p.evaluate(110);
  assert.equal(p.evaluate(140).type, 'disabled');
  assert.equal(p.confirm(warning.token, 140), false);
  silent(p, 150, 150);
  p.observe('remote', { at: 160, speech: false, healthy: false });
  assert.equal(p.evaluate(160).type, 'disabled');
});
test('pause and user extension restart the full silence interval', () => {
  const p = create(); silent(p, 0, 100); const old = p.evaluate(100);
  p.pause(); silent(p, 110, 200);
  assert.equal(p.evaluate(200).type, 'paused');
  p.resume(); silent(p, 210, 310);
  const next = p.evaluate(310);
  assert.notEqual(next.token, old.token);
  p.extend(310); silent(p, 320, 340);
  assert.equal(p.confirm(next.token, 340), false);
  assert.equal(p.evaluate(340).type, 'listening');
});
test('out-of-order VAD result cannot erase newer speech observation', () => {
  const p = create(); silent(p, 0, 100);
  p.observe('remote', { at: 110, speech: true, healthy: true });
  assert.equal(p.observe('remote', { at: 100, speech: false, healthy: true }), false);
  assert.equal(p.evaluate(110).type, 'listening');
});
