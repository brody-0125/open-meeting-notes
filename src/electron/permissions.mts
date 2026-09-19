import { APP_URL, assertSender } from './policy.mjs';

const appOrigin = origin => origin === 'omn://app' || origin === 'omn://app/';

// Main-only: arm only after validating Recording's session-bound consent.
// A grant permits acquisition, not unattended source selection or OS approval.
export class CapturePermissions {
  #window;
  #frame;
  #deadline = 0;
  #now;
  #lifetime;
  #grant;
  constructor(window, { now = () => performance.now(), lifetimeMs = 120000 } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error('invalid permission lifetime');
    this.#window = window; this.#now = now; this.#lifetime = lifetimeMs;
  }
  arm(event) {
    assertSender(event, this.#window);
    this.#frame = event.senderFrame;
    this.#grant = Symbol('capture-grant');
    this.#deadline = this.#now() + this.#lifetime;
  }
  revoke() { this.#frame = undefined; this.#deadline = 0; this.#grant = undefined; }
  #active(contents) {
    const now = this.#now();
    return Number.isFinite(now) && now >= 0 && now < this.#deadline && !this.#window.isDestroyed() &&
      contents === this.#window.webContents && this.#frame && contents.mainFrame === this.#frame && this.#frame.url === APP_URL;
  }
  #document(contents, details) {
    return Boolean(this.#active(contents) && details?.isMainFrame === true && details.requestingUrl === APP_URL);
  }
  check(contents, permission, origin, details) {
    if (!this.#document(contents, details) || !appOrigin(origin)) return false;
    if (permission === 'display-capture') return true;
    return permission === 'media' && details.mediaType === 'audio' && appOrigin(details.securityOrigin);
  }
  request(contents, permission, details) {
    if (!this.#document(contents, details)) return false;
    if (permission === 'display-capture') return true;
    if (permission !== 'media' || !appOrigin(details.securityOrigin) || !Array.isArray(details.mediaTypes)) return false;
    // Electron 44 getDisplayMedia requests media with no types before the picker; camera stays denied.
    return details.mediaTypes.length === 0 || details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
  }
  displayTicket(request) { return this.display(request) ? this.#grant : undefined; }
  display(request, ticket = this.#grant) {
    return Boolean(ticket && ticket === this.#grant && this.#active(this.#window.webContents) && request?.frame === this.#frame && appOrigin(request.securityOrigin) &&
      request.userGesture === true && request.audioRequested === true && request.videoRequested === true);
  }
}

// Dedicated app session only. Source picker integration must replace the explicit
// display denial with a user selection checked by gate.display before AND after it.
export function installCapturePermissions(session, window) {
  const gate = new CapturePermissions(window);
  session.setPermissionCheckHandler((contents, permission, origin, details) => gate.check(contents, permission, origin, details));
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(gate.request(contents, permission, details)));
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) gate.revoke(); });
  window.webContents.on('render-process-gone', () => gate.revoke());
  window.webContents.on('destroyed', () => gate.revoke());
  return gate;
}
