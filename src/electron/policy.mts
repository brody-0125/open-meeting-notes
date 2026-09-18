export const APP_URL = 'omn://app/index.html';
export function isLocalResource(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'omn:' && url.host === 'app' && !url.username && !url.password && !url.port;
  } catch { return false; }
}
export function assertSender(event, window) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== APP_URL) throw new Error('untrusted IPC sender');
}
