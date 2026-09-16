import { open, lstat, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ChunkStore } from './store.mjs';
import { PauseStore } from './pauses.mjs';

function descriptor(index, sessionId, cutoffs, pauses) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(sessionId)) throw new Error('invalid session');
  if (!cutoffs || Object.keys(cutoffs).length !== 2 || !['microphone', 'remote'].every(s => Number.isSafeInteger(cutoffs[s]) && cutoffs[s] >= 0)) throw new Error('invalid cutoff');
  if (index.errors.length || index.partials.length) throw new Error('damaged or partial audio');
  const ordered = [...index.chunks].sort((a, b) => a.file.localeCompare(b.file, 'en'));
  const formats = {};
  for (const chunk of ordered) if (chunk.meta.sessionId !== sessionId || chunk.meta.epoch !== 0) throw new Error('mixed recording session or epoch');
  for (const source of ['microphone', 'remote']) {
    let frame = 0, seq = 0, format, pauseIndex = 0;
    const advancePauses = final => {
      while (pauseIndex < pauses.length && pauses[pauseIndex].cutoffs[source] === frame) {
        const pause = pauses[pauseIndex++];
        if (pause.starts === null) {
          if (!final) throw new Error('audio after open pause');
        } else frame = pause.starts[source];
      }
      if (pauseIndex < pauses.length && pauses[pauseIndex].cutoffs[source] < frame) throw new Error('audio crosses pause boundary');
    };
    for (const { meta } of ordered.filter(c => c.meta.source === source).sort((a, b) => a.meta.seq - b.meta.seq)) {
      advancePauses(false);
      if (meta.seq !== seq++ || meta.startFrame !== frame) throw new Error('audio gap');
      format ??= { sampleRate: meta.sampleRate, channels: meta.channels };
      if (format.sampleRate !== meta.sampleRate || format.channels !== meta.channels) throw new Error('audio format changed');
      frame += meta.frames;
    }
    advancePauses(true);
    if (pauseIndex !== pauses.length) throw new Error('unmatched pause boundary');
    if (frame !== cutoffs[source]) throw new Error('audio cutoff mismatch');
    formats[source] = format ?? null;
  }
  return { version: pauses.length ? 2 : 1, sessionId, cutoffs: { microphone: cutoffs.microphone, remote: cutoffs.remote }, formats,
    ...(pauses.length ? { pausesHash: createHash('sha256').update(JSON.stringify(pauses)).digest('hex') } : {}),
    chunks: ordered.length, indexHash: createHash('sha256').update(JSON.stringify(ordered.map(c => [c.file, c.checksum]))).digest('hex') };
}
async function readMarker(root) {
  const path = join(root, 'complete.json');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('unsafe completion marker');
  const file = await open(path, 'r');
  try { return JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
}

// Only after Recording.finish(), with the session directory exclusively owned
// and no further writes. This marker detects corruption, not malicious forgery.
export async function sealRecording({ store, sessionId, cutoffs, checkpoint = async () => {} }) {
  const pauses = await new PauseStore(store.root, sessionId).read();
  const value = descriptor(await store.index(), sessionId, cutoffs, pauses);
  const bytes = JSON.stringify(value);
  try {
    if (JSON.stringify(await readMarker(store.root)) !== bytes) throw new Error('completion marker conflict');
    return value;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(store.root, `.seal-${randomUUID()}.tmp`);
  const file = await open(temp, 'wx');
  try {
    await file.writeFile(bytes);
    await checkpoint('written');
    await file.sync();
    await checkpoint('synced');
  } finally { await file.close(); }
  await rename(temp, join(store.root, 'complete.json'));
  await checkpoint('renamed');
  if (process.platform !== 'win32') {
    const dir = await open(store.root, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  return value;
}

export async function inspectRecording(root) {
  let marker;
  try { marker = await readMarker(root); }
  catch (error) {
    if (error.code !== 'ENOENT') return { state: 'damaged', reason: error.message };
    try {
      const directory = await lstat(root);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe recording directory');
      const index = await new ChunkStore(root).index();
      // Partial writes are expected after a crash, but committed chunks must
      // still pass their checksums even when completion was never recorded.
      if (index.errors.length) return { state: 'damaged', reason: 'invalid committed audio chunks' };
      return { state: 'incomplete', reason: error.message };
    } catch (failure) { return { state: 'damaged', reason: failure.message }; }
  }
  try {
    const index = await new ChunkStore(root).index();
    const pauses = await new PauseStore(root, marker?.sessionId).read();
    const expected = descriptor(index, marker?.sessionId, marker?.cutoffs, pauses);
    if (JSON.stringify(marker) !== JSON.stringify(expected)) throw new Error('completion marker mismatch');
    return { state: 'complete', ...expected, ...(pauses.length ? { pauses } : {}), index };
  } catch (error) { return { state: 'damaged', reason: error.message }; }
}
