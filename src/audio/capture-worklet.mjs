import { PcmChunker } from './pcm.mjs';

class CaptureProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.state = 'idle';
    this.pauseId = 0;
    this.pending = new Set();
    const { maxPendingChunks = 8, ...options } = processorOptions;
    if (!Number.isSafeInteger(maxPendingChunks) || maxPendingChunks < 1 || maxPendingChunks > 32) throw new Error('invalid queue limit');
    this.limit = maxPendingChunks;
    this.chunker = new PcmChunker({ ...options, sampleRate }, chunk => {
      if (this.pending.size >= this.limit) throw new Error('capture message queue exceeded');
      this.pending.add(chunk.meta.seq);
      this.port.postMessage({ type: 'chunk', ...chunk }, [chunk.pcm]);
    });
    this.port.onmessage = ({ data }) => {
      try {
        if (data?.type === 'ack') { this.pending.delete(data.seq); return; }
        if (data?.type === 'start' && this.state === 'idle') { this.state = 'recording'; return; }
        if (['pause', 'resume'].includes(data?.type) && !['stopped', 'failed'].includes(this.state)) {
          if (data.type === 'pause') {
            if (this.state !== 'recording' || !Number.isSafeInteger(data.pauseId) || data.pauseId <= this.pauseId)
              throw new Error('invalid capture pause');
            this.pauseFrame = currentFrame;
            this.pauseCutoff = this.chunker.pause();
            this.pauseId = data.pauseId;
            this.state = 'paused';
            this.port.postMessage({ type: 'paused', pauseId: this.pauseId, cutoff: this.pauseCutoff });
          } else {
            if (this.state !== 'paused' || data.pauseId !== this.pauseId) throw new Error('invalid capture resume');
            const elapsed = currentFrame - this.pauseFrame;
            this.chunker.resume(elapsed);
            this.state = 'recording';
            this.port.postMessage({ type: 'resumed', pauseId: this.pauseId, startFrame: this.pauseCutoff + elapsed });
          }
          return;
        }
        if (data?.type === 'stop' && ['idle', 'recording', 'paused'].includes(this.state)) {
          this.state = 'stopped';
          const cutoff = this.chunker.stop();
          this.port.postMessage({ type: 'stopped', cutoff });
        }
      } catch (error) { this.fail(error); }
    };
  }
  fail(error) {
    this.state = 'failed';
    this.port.postMessage({ type: 'capture-error', message: error.message });
  }
  process(inputs) {
    if (['idle', 'paused'].includes(this.state)) return true;
    if (this.state !== 'recording') return false;
    try { this.chunker.push(inputs[0]); }
    catch (error) { this.fail(error); return false; }
    // Outputs remain zero to avoid replaying the microphone into the speakers.
    return true;
  }
}

registerProcessor('meeting-capture', CaptureProcessor);
