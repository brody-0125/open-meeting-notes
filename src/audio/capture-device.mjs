import { CaptureDrain } from './capture-drain.mjs';

// Takes ownership of the supplied context and streams, including on failure.
// Permission prompts and Main's consent approval happen before this call.
export async function prepareCapture({ context, streams, sessionId, sink }) {
  const nodes = [], listeners = [], meters = {};
  let drain, timer, cleaning, previewing = false, preparingPreview = false;
  const tracks = [...new Set(['microphone', 'remote'].flatMap(source => streams?.[source]?.getTracks() ?? []))];
  const listen = (target, event, fn) => {
    target.addEventListener(event, fn);
    listeners.push(() => target.removeEventListener(event, fn));
  };
  function cleanup() {
    return cleaning ??= (async () => {
      clearInterval(timer);
      for (const remove of listeners) remove();
      for (const node of nodes) {
        try { node.disconnect(); } catch { /* Continue releasing other nodes. */ }
        node.port?.close();
      }
      for (const track of tracks) track.stop();
      if (context && context.state !== 'closed') await context.close();
    })();
  }
  const checkTracks = () => {
    for (const source of ['microphone', 'remote']) {
      const audio = streams?.[source]?.getAudioTracks();
      if (!audio || audio.length !== 1 || audio[0].readyState !== 'live' || audio[0].muted || !audio[0].enabled) throw new Error(`${source} input unavailable`);
    }
    if (streams.microphone.getAudioTracks()[0] === streams.remote.getAudioTracks()[0]) throw new Error('independent audio sources required');
  };
  try {
    checkTracks();
    if (!context || context.state === 'closed') throw new Error('audio context unavailable');
    await context.audioWorklet.addModule('/capture-worklet.mjs');
    checkTracks();
    const ports = {};
    for (const source of ['microphone', 'remote']) {
      const input = context.createMediaStreamSource(streams[source]);
      nodes.push(input);
      const capture = new AudioWorkletNode(context, 'meeting-capture', { processorOptions: { sessionId, source } });
      nodes.push(capture);
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      nodes.push(analyser);
      meters[source] = { analyser, samples: new Float32Array(analyser.fftSize) };
      input.connect(analyser).connect(capture).connect(context.destination);
      ports[source] = capture.port;
      listen(capture, 'processorerror', () => drain.fail(new Error(`${source} processor unavailable`)));
      const track = streams[source].getAudioTracks()[0];
      for (const event of ['ended', 'mute']) listen(track, event, () => drain.fail(new Error(`${source} input unavailable: ${event}`)));
    }
    drain = new CaptureDrain(ports, sink, { onDrained: cleanup });
    const done = drain.done.finally(cleanup);
    done.catch(() => {});
    listen(context, 'statechange', () => {
      if ((previewing && drain.state === 'idle' || ['recording', 'pausing', 'paused', 'resuming', 'draining'].includes(drain.state)) && context.state !== 'running') drain.fail(new Error('audio context unavailable'));
    });
    // enabled=false and track.stop() do not reliably emit ended/mute events.
    timer = setInterval(() => {
      if (!['idle', 'recording', 'pausing', 'paused', 'resuming', 'draining'].includes(drain.state)) return;
      try { checkTracks(); } catch (error) { drain.fail(error); }
    }, 250);
    let starting = false;
    return {
      get state() { return drain.state; },
      done,
      levels() {
        if (!(drain.state === 'recording' || previewing && drain.state === 'idle') || context.state !== 'running') return null;
        return Object.fromEntries(Object.entries(meters).map(([source, { analyser, samples }]) => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          return [source, Math.min(1, Math.sqrt(sum / samples.length))];
        }));
      },
      async preflight() {
        if (starting || preparingPreview || previewing || drain.state !== 'idle') throw new Error('preflight unavailable');
        preparingPreview = true;
        try {
          checkTracks();
          await context.resume();
          if (context.state !== 'running' || drain.state !== 'idle') throw new Error('preflight unavailable');
          checkTracks();
          previewing = true;
        } catch (error) { drain.fail(error); await cleanup(); throw error; }
        finally { preparingPreview = false; }
      },
      async start() {
        if (starting || preparingPreview || drain.state !== 'idle') throw new Error('capture already started');
        starting = true;
        try {
          checkTracks();
          await context.resume();
          if (context.state !== 'running') throw new Error('audio context unavailable');
          checkTracks();
          drain.start();
        } catch (error) { drain.fail(error); await cleanup(); throw error; }
      },
      pause() { return drain.pause(); },
      resume() {
        try {
          checkTracks();
          if (context.state !== 'running') throw new Error('audio context unavailable');
        } catch (error) { drain.fail(error); return done; }
        return drain.resume();
      },
      stop() { drain.stop(); return done; },
      abort(reason = 'capture cancelled') { drain.fail(new Error(reason)); return done; }
    };
  } catch (error) {
    if (drain) drain.fail(error);
    else { try { await sink?.abort(error.message); } catch { /* Preserve setup failure. */ } }
    await cleanup();
    throw error;
  }
}
