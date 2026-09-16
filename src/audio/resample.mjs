// Browser renderer utility. Native Web Audio performs band-limited resampling;
// this module never relabels a 48kHz array as 16kHz.
export async function prepareSttAudio(window, jobId) {
  const { sampleRate, samples, startFrame, source } = window;
  if (![16000, 44100, 48000].includes(sampleRate) || !(samples instanceof Float32Array) ||
    samples.length < 1 || samples.length > sampleRate * 30 || !samples.every(Number.isFinite) ||
    !Number.isSafeInteger(startFrame) || startFrame < 0) throw new Error('invalid source audio');
  const length = Math.round(samples.length * 16000 / sampleRate);
  if (!length) throw new Error('source audio too short');
  let converted;
  if (sampleRate === 16000) converted = samples.slice();
  else {
    const context = new OfflineAudioContext(1, length, 16000);
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    node.start();
    converted = (await context.startRendering()).getChannelData(0).slice();
  }
  return { jobId, source, sampleRate: 16000, startFrame: Math.round(startFrame * 16000 / sampleRate), samples: converted,
    origin: { startFrame, sampleRate, frames: samples.length } };
}
