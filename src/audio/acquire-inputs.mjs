// Call directly from the approved user gesture: display capture needs activation.
// `approved` is a UI precondition, not Main's session-bound consent credential.
// The caller owns all returned tracks and must pass them to prepareCapture or stop them.
export function acquireInputs({ approved, signal, mediaDevices = globalThis.navigator?.mediaDevices } = {}) {
  if (approved !== true) return Promise.reject(new Error('recording approval required'));
  if (signal?.aborted) return Promise.reject(new DOMException('Capture cancelled', 'AbortError'));
  if (typeof mediaDevices?.getDisplayMedia !== 'function' || typeof mediaDevices?.getUserMedia !== 'function') return Promise.reject(new Error('media capture unavailable'));
  return new Promise((resolve, reject) => {
    const acquired = [];
    let cancelled = false;
    const release = () => {
      for (const stream of acquired) for (const track of stream.getTracks()) track.stop();
    };
    const abort = () => {
      cancelled = true;
      release();
      reject(new DOMException('Capture cancelled', 'AbortError'));
    };
    const checkCancelled = () => {
      if (cancelled) throw new DOMException('Capture cancelled', 'AbortError');
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Async body begins synchronously: do not await an IPC or another prompt first.
    (async () => {
      const remote = await mediaDevices.getDisplayMedia({ video: true, audio: true });
      acquired.push(remote);
      checkCancelled();
      checkAudio(remote, 'shared audio');
      const microphone = await mediaDevices.getUserMedia({ video: false, audio: {
        channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true
      } });
      acquired.push(microphone);
      checkCancelled();
      checkAudio(remote, 'shared audio');
      checkAudio(microphone, 'microphone');
      signal?.removeEventListener('abort', abort);
      resolve({ microphone, remote });
    })().catch(error => {
      release();
      reject(error);
    }).finally(() => signal?.removeEventListener('abort', abort));
  });
}

function checkAudio(stream, label) {
  const tracks = stream.getAudioTracks();
  if (tracks.length !== 1 || tracks[0].readyState !== 'live' || !tracks[0].enabled || tracks[0].muted) throw new Error(`${label} unavailable; select a source that supplies audio`);
}
