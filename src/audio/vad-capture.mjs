// Borrows already-authorized streams. Owns only its separate 16 kHz graph,
// never the microphone/system tracks or the primary recording graph.
export async function prepareVadCapture({ streams, onFrame, onFailure,
  createContext = () => new AudioContext({ sampleRate: 16000 }) }) {
  if (typeof onFrame !== 'function' || typeof onFailure !== 'function') throw new Error('VAD callbacks required');
  const context = createContext(), nodes = [], ports = [], removers = [], abort = new AbortController();
  let running = false, starting = false, stopped = false, closing, timer, queue = Promise.resolve();
  const tracks = ['microphone', 'remote'].map(source => {
    const audio = streams?.[source]?.getAudioTracks(); return audio?.length === 1 ? audio[0] : null;
  });
  const check = () => {
    if (tracks[0] === tracks[1] || tracks.some(t => !t || !t.enabled || t.muted || t.readyState !== 'live')) throw new Error('VAD input unavailable');
    if (running && context.state !== 'running') throw new Error('VAD context interrupted');
  };
  function stop() {
    if (closing) return closing;
    stopped = true; running = false; abort.abort(); clearInterval(timer);
    for (const remove of removers) remove();
    for (const node of nodes) { try { node.disconnect(); } catch {} node.port?.close(); }
    closing = context.state === 'closed' ? Promise.resolve() : context.close();
    return closing;
  }
  function fail(error) {
    if (stopped) return;
    void stop().finally(() => onFailure(error)).catch(() => {});
  }
  try {
    check();
    if (context.sampleRate !== 16000) throw new Error('16 kHz VAD context unavailable');
    await context.audioWorklet.addModule('/vad-worklet.mjs');
    check();
    for (const [index, source] of ['microphone', 'remote'].entries()) {
      const input = context.createMediaStreamSource(streams[source]); nodes.push(input);
      const worklet = new AudioWorkletNode(context, 'meeting-vad'); nodes.push(worklet); ports.push(worklet.port);
      input.connect(worklet).connect(context.destination);
      let next = 0;
      worklet.port.onmessage = ({ data }) => {
        if (!running || stopped) return;
        if (data?.type === 'vad-error') { fail(new Error(data.message)); return; }
        if (data?.type !== 'vad-frame' || data.seq !== next || data.startFrame !== next * 512 ||
            !(data.samples instanceof Float32Array) || data.samples.length !== 512 || !Number.isFinite(data.endTime) || data.endTime < 0 || data.endTime > context.currentTime + .1) {
          fail(new Error('invalid VAD frame sequence')); return;
        }
        next++;
        // Convert audio clock to monotonic observation time at receipt. Queue
        // latency must not make old audio look like fresh evidence of silence.
        const capturedAt = Math.max(0, performance.now() - Math.max(0, context.currentTime - data.endTime) * 1000);
        queue = queue.then(async () => {
          if (stopped) return;
          await onFrame({ source, samples: data.samples, startFrame: data.startFrame, capturedAt }, abort.signal);
          if (!stopped) worklet.port.postMessage({ type: 'ack', seq: data.seq });
        }).catch(fail);
      };
      worklet.onprocessorerror = () => fail(new Error('VAD processor unavailable'));
      for (const event of ['ended', 'mute']) {
        const listener = () => fail(new Error(`VAD ${source} input ${event}`));
        tracks[index].addEventListener(event, listener); removers.push(() => tracks[index].removeEventListener(event, listener));
      }
    }
    return {
      async start() {
        if (running || starting || stopped) throw new Error('VAD capture already started or stopped');
        starting = true;
        try {
          check(); await context.resume();
          if (stopped) throw new Error('VAD capture stopped');
          running = true; check();
          for (const port of ports) port.postMessage({ type: 'start' });
          timer = setInterval(() => { try { check(); } catch (error) { fail(error); } }, 100);
        } catch (error) { fail(error); throw error; } finally { starting = false; }
      },
      stop
    };
  } catch (error) { await stop(); throw error; }
}
