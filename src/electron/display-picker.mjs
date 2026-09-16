// Main-only picker coordinator. enumerate/choose are trusted Main functions.
// Windows loopback captures system-wide output, not just a chosen window's audio.
export function createDisplayPicker({ gate, enumerate, choose, platform, timeoutMs = 120000 }) {
  if (typeof enumerate !== 'function' || typeof choose !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid display picker');
  let busy = false;
  return (request, callback) => {
    const ticket = gate.displayTicket(request);
    if (busy || !ticket || platform !== 'win32') { callback({}); return; }
    busy = true;
    let settled = false;
    const controller = new AbortController();
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      callback(result);
    };
    const timer = setTimeout(() => finish({}), timeoutMs);
    const valid = () => !settled && gate.display(request, ticket);
    (async () => {
      const sources = await enumerate();
      if (!valid() || !Array.isArray(sources) || sources.length === 0) return finish({});
      const id = await choose(sources.map(({ id, name }) => ({ id, name })), controller.signal);
      if (!valid() || !id || !sources.some(source => source.id === id)) return finish({});
      const current = await enumerate();
      if (!valid()) return finish({});
      const selected = current.find(source => source.id === id);
      finish(selected ? { video: selected, audio: 'loopback' } : {});
    })().catch(() => finish({})).finally(() => { busy = false; });
  };
}

// Optional native UI adapter. No enumeration occurs until an authorized request.
export function installWindowsDisplayPicker({ session, window, gate, desktopCapturer, dialog, platform = process.platform }) {
  session.setDisplayMediaRequestHandler(createDisplayPicker({ gate, platform,
    enumerate: () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }),
    choose: async (sources, signal) => {
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: '회의 오디오 녹음', message: '공유할 화면을 선택하세요',
        detail: '선택한 화면의 영상은 저장하지 않습니다. 오디오는 특정 창만이 아니라 이 컴퓨터에서 재생되는 전체 시스템 소리를 녹음합니다.',
        buttons: ['취소', ...sources.map((source, i) => `${i + 1}. ${String(source.name || '화면').replace(/[\r\n&]/g, ' ').slice(0, 80)}`)],
        defaultId: 0, cancelId: 0, noLink: true, signal
      });
      return sources[result.response - 1]?.id ?? null;
    }
  }));
}
