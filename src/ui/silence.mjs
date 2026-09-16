import { InferenceClient } from '/inference-client.mjs';
import { prepareVadCapture } from '/vad-capture.mjs';
import { SilenceMonitor } from '/silence-monitor.mjs';

// Returns immediately so manual stop can cancel model loading as well as VAD.
export function startSilence({ streams, modelHash, onState, onStop }) {
  const client = new InferenceClient(), abort = new AbortController();
  let capture, timer, closed = false;
  const monitor = new SilenceMonitor({ onState, onStop: () => { stop(); onStop(); } });
  function stop() {
    if (closed) return;
    closed = true; clearInterval(timer); monitor.close(); abort.abort(); client.dispose();
    void capture?.stop().catch(() => {});
  }
  function failure(error) {
    if (closed) return;
    stop(); onState({ type: 'failed', reason: error.message }, performance.now());
  }
  onState({ type: 'loading' }, performance.now());
  void (async () => {
    await client.run('vad-load', { modelHash }, { signal: abort.signal });
    abort.signal.throwIfAborted();
    capture = await prepareVadCapture({ streams, onFailure: failure, onFrame: async (frame, signal) => {
      const result = await client.run('vad', { modelHash, source: frame.source, samples: frame.samples }, { signal });
      if (closed) return;
      monitor.observe(frame.source, { at: frame.capturedAt, healthy: true, speech: result.speech });
    } });
    if (closed) { await capture.stop(); return; }
    await capture.start();
    if (closed) return;
    timer = setInterval(() => monitor.tick(performance.now()), 100);
  })().catch(failure);
  return { stop, extend: () => { monitor.extend(performance.now()); monitor.tick(performance.now()); } };
}
