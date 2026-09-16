import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PauseStore } from '../src/pauses.mjs';
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'omn-pauses-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const pause = () => ({ pauseId: 1, cutoffs: { microphone: 48000, remote: 47900 } });
const resume = () => ({ pauseId: 1, starts: { microphone: 96000, remote: 95900 } });

test('pause and resume survive reload, bind session and support identical retries', async t => {
  const root = await directory(t), store = new PauseStore(root, 'meeting');
  assert.deepEqual(await store.read(), []);
  assert.equal((await store.pause(pause())).durable, true);
  assert.equal((await store.pause(pause())).durable, true);
  assert.equal((await store.resume(resume())).durable, true);
  assert.equal((await store.resume(resume())).durable, true);
  assert.deepEqual(await new PauseStore(root, 'meeting').read(), [{ ...pause(), starts: resume().starts }]);
  await assert.rejects(new PauseStore(root, 'other').read(), /session/);
});

test('queued writes snapshot input and reject conflicts, open pauses and backward time', async t => {
  const store = new PauseStore(await directory(t), 'meeting');
  const input = pause(), first = store.pause(input); input.cutoffs.microphone = 0;
  const second = store.resume(resume()); await Promise.all([first, second]);
  await assert.rejects(store.pause({ ...pause(), cutoffs: { microphone: 0, remote: 0 } }), /conflict/);
  await assert.rejects(store.resume({ ...resume(), starts: { microphone: 96001, remote: 95900 } }), /conflict/);
  await assert.rejects(store.pause({ pauseId: 2, cutoffs: { microphone: 95000, remote: 100000 } }), /timeline/);
  await store.pause({ pauseId: 2, cutoffs: { microphone: 100000, remote: 100000 } });
  await assert.rejects(store.pause({ pauseId: 3, cutoffs: { microphone: 110000, remote: 110000 } }), /open pause/);
  await assert.rejects(store.resume({ pauseId: 2, starts: { microphone: 99999, remote: 120000 } }), /timeline/);
  assert.equal((await store.read())[0].cutoffs.microphone, 48000);
});

test('failed pre-rename commit keeps prior record and never returns durable ACK', async t => {
  const root = await directory(t); await new PauseStore(root, 'meeting').pause(pause());
  const before = await readFile(join(root, 'pauses.json'));
  const broken = new PauseStore(root, 'meeting', { checkpoint: stage => { if (stage === 'synced') throw new Error('disk failure'); } });
  await assert.rejects(broken.resume(resume()), /disk failure/);
  assert.deepEqual(await readFile(join(root, 'pauses.json')), before);
  assert.equal((await new PauseStore(root, 'meeting').read())[0].starts, null);
});

test('post-rename failure is uncertain completion and retry verifies persisted data', async t => {
  const root = await directory(t);
  const broken = new PauseStore(root, 'meeting', { checkpoint: stage => { if (stage === 'renamed') throw new Error('interrupted'); } });
  await assert.rejects(broken.pause(pause()), /interrupted/);
  const fresh = new PauseStore(root, 'meeting');
  assert.equal((await fresh.pause(pause())).durable, true);
  assert.deepEqual(await fresh.read(), [{ ...pause(), starts: null }]);
});

test('corrupt persisted boundaries cannot be overwritten with a new successful pause', async t => {
  const root = await directory(t), store = new PauseStore(root, 'meeting');
  await store.pause(pause());
  const path = join(root, 'pauses.json'), body = JSON.parse(await readFile(path, 'utf8'));
  body.pauses[0].cutoffs.remote++;
  await writeFile(path, JSON.stringify(body));
  await assert.rejects(store.read(), /integrity/);
  await assert.rejects(store.resume(resume()), /integrity/);
});

test('valid checksums cannot make invalid schema, ordering or boundaries acceptable', async t => {
  const root = await directory(t), store = new PauseStore(root, 'meeting');
  for (const mutate of [body => { body.version = 2; }, body => { body.extra = true; },
    body => { body.pauses[0].cutoffs.remote = -1; }, body => { body.pauses[0].pauseId = 2; },
    body => { body.pauses[0].starts = { microphone: 1, remote: 2 }; },
    body => { body.pauses.push({ ...pause(), pauseId: 2, starts: null }); }]) {
    const body = { version: 1, sessionId: 'meeting', pauses: [{ ...pause(), starts: null }] };
    mutate(body);
    const checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await writeFile(join(root, 'pauses.json'), JSON.stringify({ ...body, checksum }));
    await assert.rejects(store.read());
  }
});

test('durable acknowledgment follows the final commit checkpoint', async t => {
  const root = await directory(t); let release, entered;
  const committed = new Promise(resolve => { entered = resolve; });
  const store = new PauseStore(root, 'meeting', { checkpoint: stage => {
    if (stage === 'committed') { entered(); return new Promise(resolve => { release = resolve; }); }
  } });
  let acknowledged = false;
  const pending = store.pause(pause()).then(ack => { acknowledged = true; return ack; });
  await committed; assert.equal(acknowledged, false);
  release(); assert.equal((await pending).durable, true);
});
