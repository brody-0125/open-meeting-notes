import { validatePauses } from '../pauses.mjs';

// Main-process pull reader. At most one file plus the bounded input window is
// retained by this generator. Consumers must also avoid accumulating windows.
export async function* pcmWindows(store, index, { sessionId, source, epoch = 0, windowFrames, overlapFrames, signal, pauses = [] }) {
  // Production callers supply the metadata verified by inspectRecording.
  pauses = structuredClone(pauses); validatePauses(pauses);
  if (pauses.length && epoch !== 0) throw new Error('unsupported pause epoch');
  if (index.errors.length) throw new Error('damaged recording requires recovery review');
  if (index.partials.length) throw new Error('incomplete recording requires recovery review');
  if (!['microphone', 'remote'].includes(source)) throw new Error('invalid source');
  const descriptors = index.chunks.filter(c => c.meta.sessionId === sessionId && c.meta.source === source && c.meta.epoch === epoch)
    .sort((a, b) => a.meta.seq - b.meta.seq);
  let buffer, used = 0, nextFrame = 0, startFrame, sampleRate, channels, nextSeq = 0, newFrames = 0, pauseIndex = 0;
  for (const descriptor of descriptors) {
    signal?.throwIfAborted();
    const { meta, pcm, checksum } = await store.read(descriptor.file);
    if (checksum !== descriptor.checksum || Object.keys(meta).some(k => meta[k] !== descriptor.meta[k])) throw new Error('recording changed after indexing');
    if (!buffer) {
      sampleRate = meta.sampleRate; channels = meta.channels;
      windowFrames ??= sampleRate * 30;
      overlapFrames ??= sampleRate * 2;
      if (!Number.isSafeInteger(windowFrames) || windowFrames < 1 || windowFrames > sampleRate * 30 ||
        !Number.isSafeInteger(overlapFrames) || overlapFrames < 0 || overlapFrames >= windowFrames) throw new Error('invalid audio window');
      buffer = new Float32Array(windowFrames);
      startFrame = nextFrame = pauses.length ? 0 : meta.startFrame;
    }
    while (pauseIndex < pauses.length && pauses[pauseIndex].cutoffs[source] === nextFrame) {
      const pause = pauses[pauseIndex++];
      if (pause.starts === null) throw new Error('audio after open pause');
      if (newFrames > 0) {
        signal?.throwIfAborted();
        yield { sessionId, source, epoch, startFrame, sampleRate, samples: buffer.slice(0, used) };
      }
      used = newFrames = 0;
      startFrame = nextFrame = pause.starts[source];
    }
    if (meta.seq !== nextSeq || meta.startFrame !== nextFrame) throw new Error('audio gap or duplicate detected');
    if (pauseIndex < pauses.length && pauses[pauseIndex].cutoffs[source] < meta.startFrame + meta.frames)
      throw new Error('audio crosses pause boundary');
    if (meta.sampleRate !== sampleRate || meta.channels !== channels) throw new Error('audio format changed within epoch');
    const bytes = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let frame = 0; frame < meta.frames; frame++) {
      let value = 0;
      for (let channel = 0; channel < channels; channel++) value += bytes.getInt16((frame * channels + channel) * 2, true) / (32768 * channels);
      buffer[used++] = value;
      newFrames++;
      if (used === windowFrames) {
        signal?.throwIfAborted();
        yield { sessionId, source, epoch, startFrame, sampleRate, samples: buffer.slice() };
        buffer.copyWithin(0, windowFrames - overlapFrames);
        used = overlapFrames;
        newFrames = 0;
        startFrame += windowFrames - overlapFrames;
      }
    }
    nextFrame += meta.frames; nextSeq++;
  }
  while (pauseIndex < pauses.length && pauses[pauseIndex].cutoffs[source] === nextFrame) {
    const pause = pauses[pauseIndex++];
    if (pause.starts !== null) nextFrame = pause.starts[source];
  }
  if (pauseIndex !== pauses.length) throw new Error('unmatched pause boundary');
  if (newFrames > 0) {
    signal?.throwIfAborted();
    yield { sessionId, source, epoch, startFrame, sampleRate, samples: buffer.slice(0, used) };
  }
}
