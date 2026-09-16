import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireInputs } from '../src/audio/acquire-inputs.mjs';

function stream(kinds = ['audio']) {
  const tracks = kinds.map(kind => ({ kind, readyState: 'live', enabled: true, muted: false,
    stop() { this.readyState = 'ended'; } }));
  return { getTracks: () => tracks, getAudioTracks: () => tracks.filter(t => t.kind === 'audio') };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('requires approval; display prompt starts synchronously before microphone prompt', async () => {
  const calls = [], remote = stream(['video', 'audio']), microphone = stream();
  const mediaDevices = {
    getDisplayMedia: constraints => { calls.push(['display', constraints]); return Promise.resolve(remote); },
    getUserMedia: constraints => { calls.push(['mic', constraints]); return Promise.resolve(microphone); }
  };
  await assert.rejects(acquireInputs({ mediaDevices, approved: false }), /approval/);
  assert.deepEqual(calls, []);
  const pending = acquireInputs({ mediaDevices, approved: true });
  assert.equal(calls[0][0], 'display');
  const result = await pending;
  assert.equal(result.remote, remote);
  assert.equal(result.microphone, microphone);
  assert.equal(calls[0][1].audio, true);
  assert.equal(calls[1][1].video, false);
  assert.ok(remote.getTracks().every(t => t.readyState === 'live'));
});

test('missing shared audio prevents microphone request and releases video', async () => {
  const remote = stream(['video']);
  let requested = false;
  await assert.rejects(acquireInputs({ approved: true, mediaDevices: {
    getDisplayMedia: async () => remote,
    getUserMedia: async () => { requested = true; return stream(); }
  } }), /shared audio/);
  assert.equal(requested, false);
  assert.equal(remote.getTracks()[0].readyState, 'ended');
});

test('microphone permission rejection releases the accepted display stream', async () => {
  const remote = stream(['video', 'audio']);
  await assert.rejects(acquireInputs({ approved: true, mediaDevices: {
    getDisplayMedia: async () => remote,
    getUserMedia: async () => { throw new Error('permission denied'); }
  } }), /permission denied/);
  assert.ok(remote.getTracks().every(t => t.readyState === 'ended'));
});

test('cancel returns promptly and releases a late permission grant without further prompts', async () => {
  const controller = new AbortController(), remote = stream(['video', 'audio']);
  let grant, mic = false;
  const pending = acquireInputs({ approved: true, signal: controller.signal, mediaDevices: {
    getDisplayMedia: () => new Promise(resolve => { grant = resolve; }),
    getUserMedia: async () => { mic = true; return stream(); }
  } });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  grant(remote);
  await tick();
  assert.equal(mic, false);
  assert.ok(remote.getTracks().every(t => t.readyState === 'ended'));
});

test('cancel during microphone prompt closes both early and late tracks', async () => {
  const controller = new AbortController(), remote = stream(['video', 'audio']), microphone = stream();
  let grant;
  const pending = acquireInputs({ approved: true, signal: controller.signal, mediaDevices: {
    getDisplayMedia: async () => remote,
    getUserMedia: () => new Promise(resolve => { grant = resolve; })
  } });
  await tick();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(remote.getTracks().every(t => t.readyState === 'ended'));
  grant(microphone);
  await tick();
  assert.equal(microphone.getTracks()[0].readyState, 'ended');
});

test('completed acquisition transfers ownership; later abort does not stop caller streams', async () => {
  const controller = new AbortController(), remote = stream(), microphone = stream();
  await acquireInputs({ approved: true, signal: controller.signal, mediaDevices: {
    getDisplayMedia: async () => remote, getUserMedia: async () => microphone
  } });
  controller.abort();
  assert.ok([...remote.getTracks(), ...microphone.getTracks()].every(t => t.readyState === 'live'));
});
