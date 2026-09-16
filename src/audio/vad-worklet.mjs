// Dedicated 16 kHz graph; the browser performs streaming sample-rate conversion.
// Never pads a missing input or an incomplete tail with silence.
class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    if (sampleRate !== 16000) throw new Error('VAD requires 16 kHz context');
    this.state = 'idle'; this.buffer = new Float32Array(512); this.used = 0; this.seq = 0; this.pending = new Set();
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'ack') this.pending.delete(data.seq);
      else if (data?.type === 'start' && this.state === 'idle') this.state = 'running';
      else if (data?.type === 'stop') this.state = 'stopped';
    };
  }
  process(inputs) {
    if (this.state === 'idle') return true;
    if (this.state !== 'running') return false;
    try {
      const channels = inputs[0], length = channels?.[0]?.length;
      if (!length || channels.some(c => c.length !== length)) throw new Error('VAD input missing');
      for (let i = 0; i < length; i++) {
        let value = 0;
        for (const channel of channels) {
          if (!Number.isFinite(channel[i])) throw new Error('invalid VAD sample');
          value += channel[i] / channels.length;
        }
        this.buffer[this.used++] = Math.max(-1, Math.min(1, value));
        if (this.used === 512) {
          if (this.pending.size >= 4) throw new Error('VAD processing backlog');
          const seq = this.seq++, samples = this.buffer;
          this.pending.add(seq);
          this.port.postMessage({ type: 'vad-frame', seq, startFrame: seq * 512,
            endTime: currentTime + (i + 1) / sampleRate, samples }, [samples.buffer]);
          this.buffer = new Float32Array(512); this.used = 0;
        }
      }
      return true;
    } catch (error) {
      this.state = 'failed'; this.port.postMessage({ type: 'vad-error', message: error.message }); return false;
    }
  }
}
registerProcessor('meeting-vad', VadProcessor);
