import { startApp } from '../../src/electron/app.mjs';

startApp({ directory: process.env.OMN_APP_TEST_DIRECTORY, show: false, confirm: async () => true }).then(async window => {
  if (!window) throw new Error('fixture profile already owned');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const { id } = await window.meeting.prepare();
    await window.meeting.acquired(id);
    const acks = [];
    for (let seq = 0; seq < 4; seq++) for (const source of ['microphone', 'remote']) {
      const pcm = new Uint8Array(32000), view = new DataView(pcm.buffer);
      const value = (source === 'microphone' ? 1 : -1) * (100 + seq);
      for (let offset = 0; offset < pcm.length; offset += 2) view.setInt16(offset, value, true);
      acks.push(await window.meeting.append(id, { meta: { version: 1, sessionId: id, epoch: 0, source, seq,
        startFrame: seq * 16000, sampleRate: 16000, channels: 1, frames: 16000 }, pcm }));
    }
    const mode = ${JSON.stringify(process.env.OMN_CRASH_PAUSE ?? 'none')};
    if (mode !== 'none') {
      await window.meeting.pause(id, { pauseId: 1, cutoffs: { microphone: 64000, remote: 64000 } });
      if (mode === 'resumed') {
        await window.meeting.resume(id, { pauseId: 1, starts: { microphone: 80000, remote: 96000 } });
        for (const [source, startFrame] of [['microphone', 80000], ['remote', 96000]]) {
          const pcm = new Uint8Array(32000), view = new DataView(pcm.buffer);
          for (let offset = 0; offset < pcm.length; offset += 2) view.setInt16(offset, source === 'microphone' ? 104 : -104, true);
          acks.push(await window.meeting.append(id, { meta: { version: 1, sessionId: id, epoch: 0, source,
            seq: 4, startFrame, sampleRate: 16000, channels: 1, frames: 16000 }, pcm }));
        }
      }
    }
    return { id, acks };
  })()`);
  // Deliberately no stop/finish: parent terminates this still-recording process.
  process.stdout.write(`recording-ready:${JSON.stringify(result)}\n`);
}).catch(error => { console.error(error); process.exit(1); });
