import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { AudioPreview } from '../src/audio/preview.mjs';
const audio = () => ({ sampleRate: 16000, samples: new Float32Array(160) });
function fixture() {
  const contexts = [];
  const player = new AudioPreview(() => {
    const node = { starts: 0, stops: 0, connect() {}, start() { this.starts++; }, stop() { this.stops++; } };
    const context = { node, closes: 0, resume: async () => {}, close: async () => { context.closes++; },
      createBuffer: () => ({ copyToChannel() {} }), createBufferSource: () => node };
    contexts.push(context); return context;
  });
  return { player, contexts };
}
test('late audio after cancellation never starts and closes its context', async () => {
  const { player, contexts } = fixture(); let release;
  const pending = player.play(() => new Promise(resolve => { release = resolve; }));
  player.stop(); release(audio()); await pending;
  assert.equal(contexts[0].node.starts, 0); assert.equal(contexts[0].closes, 1);
});
test('replacement stops old playback; obsolete completion cannot stop new playback', async () => {
  const { player, contexts } = fixture();
  await player.play(async () => audio()); const ended = contexts[0].node.onended;
  await player.play(async () => audio()); ended();
  assert.equal(contexts[0].node.stops, 1); assert.equal(contexts[1].closes, 0);
  contexts[1].node.onended(); assert.equal(contexts[1].closes, 1);
});
test('bad audio and failed loading release resources and remain errors', async () => {
  const { player, contexts } = fixture();
  await assert.rejects(player.play(async () => ({ ...audio(), samples: Float32Array.of(NaN) })), /audio/);
  await assert.rejects(player.play(async () => { throw new Error('corrupt'); }), /corrupt/);
  assert.ok(contexts.every(c => c.closes === 1 && c.node.starts === 0));
});

test('synchronous load failure also handles an overlapping device rejection', () => {
  // A separate process keeps an unhandled rejection observable as a failed exit.
  const script = `
    import assert from 'node:assert/strict';
    import { AudioPreview } from ${JSON.stringify(new URL('../src/audio/preview.mjs', import.meta.url).href)};
    let closes = 0;
    const states = [];
    const player = new AudioPreview(() => ({
      resume: () => Promise.reject(new Error('device unavailable')),
      close: async () => { closes++; }
    }));
    await assert.rejects(player.play(() => { throw new Error('corrupt audio'); }, state => states.push(state)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closes, 1);
    assert.deepEqual(states, ['loading', 'idle']);
  `;
  execFileSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], { stdio: 'pipe' });
});
