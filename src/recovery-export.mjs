import { mkdir, lstat, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ChunkStore } from './store.mjs';
import { inspectRecording } from './recording-seal.mjs';
import { PauseStore } from './pauses.mjs';

function wavHeader(span) {
  const bytes = span.frames * span.channels * 2;
  if (!Number.isSafeInteger(bytes) || bytes > 0xffffffff - 36) throw new Error('recovered span exceeds WAV size limit');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(span.channels, 22);
  header.writeUInt32LE(span.sampleRate, 24); header.writeUInt32LE(span.sampleRate * span.channels * 2, 28);
  header.writeUInt16LE(span.channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}

// Main owns both directories exclusively during export. This salvages excerpts;
// it never seals the source or claims that a missing tail has been recovered.
export async function exportRecoveredAudio({ root, directory, sessionId }) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(sessionId)) throw new Error('invalid recovery session');
  const sourceStat = await lstat(root);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('unsafe recording directory');
  const original = await inspectRecording(root), store = new ChunkStore(root), index = await store.index();
  const readPauses = async () => {
    try {
      const records = await new PauseStore(root, sessionId).read();
      if (!records.length) return undefined;
      const verified = original.state === 'complete' && JSON.stringify(records) === JSON.stringify(original.pauses);
      return { verification: verified ? 'recording-verified' : 'metadata-only', records,
        warning: 'Recorded pause metadata. Only recording-verified boundaries were matched to all source audio; other missing intervals remain unexplained.' };
    } catch (error) { return { verification: 'unreadable', error: String(error.message).slice(0, 1000) }; }
  };
  const pauseMetadata = await readPauses();
  const chunks = index.chunks.sort((a, b) => a.meta.source.localeCompare(b.meta.source) || a.meta.epoch - b.meta.epoch || a.meta.startFrame - b.meta.startFrame);
  if (!chunks.length) throw new Error('no verified audio to recover');
  const spans = [];
  for (const chunk of chunks) {
    const m = chunk.meta, previous = spans.at(-1);
    if (m.sessionId !== sessionId) throw new Error('foreign recovery session');
    const same = previous?.source === m.source && previous.epoch === m.epoch;
    if (same && m.startFrame < previous.startFrame + previous.frames) throw new Error('overlapping recovery audio');
    if (same && previous.sampleRate !== m.sampleRate) throw new Error('ambiguous recovery timebase');
    if (same && previous.startFrame + previous.frames === m.startFrame && previous.channels === m.channels &&
        previous.chunks.at(-1).meta.seq + 1 === m.seq) {
      previous.frames += m.frames; previous.chunks.push(chunk);
    } else spans.push({ source: m.source, epoch: m.epoch, startFrame: m.startFrame, frames: m.frames,
      sampleRate: m.sampleRate, channels: m.channels, chunks: [chunk] });
  }
  // Validate every header before creating any output files.
  spans.forEach(wavHeader);
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe export directory');
  const path = join(directory, `${sessionId}-recovery-${randomUUID()}`), temporary = `${path}.partial`;
  await mkdir(temporary);
  try {
    const outputs = [];
    for (const [i, span] of spans.entries()) {
      const name = `${span.source}-${i}.wav`, file = await open(join(temporary, name), 'wx');
      try {
        await file.writeFile(wavHeader(span));
        for (const expected of span.chunks) {
          const actual = await store.read(expected.file);
          if (actual.checksum !== expected.checksum) throw new Error('audio changed during recovery');
          await file.writeFile(actual.pcm);
        }
        await file.sync();
      } finally { await file.close(); }
      const { chunks, ...metadata } = span;
      outputs.push({ file: name, ...metadata, chunks: chunks.map(c => ({ file: c.file, checksum: c.checksum })) });
    }
    if (JSON.stringify(await readPauses()) !== JSON.stringify(pauseMetadata)) throw new Error('pause metadata changed during recovery');
    const manifest = await open(join(temporary, 'recovery.json'), 'wx');
    try {
      await manifest.writeFile(JSON.stringify({ version: pauseMetadata ? 2 : 1, sessionId, state: 'recovered-excerpts', originalState: original.state,
        ...(pauseMetadata ? { pauseMetadata } : {}),
        warning: 'Verified excerpts only. Missing audio is not restored; source and epoch timelines are independent. The original remains unchanged.',
        errors: index.errors, partials: index.partials, spans: outputs }, null, 2));
      await manifest.sync();
    } finally { await manifest.close(); }
    await rename(temporary, path);
    return { path, spans: outputs.length, originalState: original.state };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
