// Policy only: input must be healthy, timestamped VAD observations. Missing
// audio and a disconnected device are not evidence of a completed meeting.
export class SilencePolicy {
  #sources = new Map();
  #warning;
  #token = 0;
  #paused = false;
  #finished = false;
  constructor({ silenceMs = 180000, warningMs = 30000, freshnessMs = 2000 } = {}) {
    for (const n of [silenceMs, warningMs, freshnessMs]) if (!Number.isFinite(n) || n <= 0) throw new Error('invalid silence policy');
    this.silenceMs = silenceMs; this.warningMs = warningMs; this.freshnessMs = freshnessMs;
  }
  observe(source, { at, speech, healthy }) {
    if (!['microphone', 'remote'].includes(source) || !Number.isFinite(at) || at < 0 || typeof speech !== 'boolean' || typeof healthy !== 'boolean') throw new Error('invalid VAD observation');
    if (this.#paused || this.#finished) return false;
    const previous = this.#sources.get(source);
    if (previous && at <= previous.at) return false;
    const gap = previous && at - previous.at > this.freshnessMs;
    if (speech || !healthy || gap) this.#warning = undefined;
    this.#sources.set(source, { at, healthy, speech,
      silentSince: healthy && !speech ? (gap || previous?.speech ? at : previous?.silentSince ?? at) : undefined });
    return true;
  }
  evaluate(now) {
    if (!Number.isFinite(now) || now < 0) throw new Error('invalid monotonic time');
    if (this.#finished) return { type: 'stopped' };
    if (this.#paused) return { type: 'paused' };
    const sources = ['microphone', 'remote'].map(source => this.#sources.get(source));
    if (sources.some(s => !s || !s.healthy || now < s.at || now - s.at > this.freshnessMs)) {
      this.#warning = undefined;
      for (const s of this.#sources.values()) s.silentSince = undefined;
      return { type: 'disabled', reason: 'VAD or source unavailable' };
    }
    if (sources.some(s => s.speech || s.silentSince === undefined) || now - Math.max(...sources.map(s => s.silentSince)) < this.silenceMs) {
      this.#warning = undefined;
      return { type: 'listening' };
    }
    this.#warning ??= { type: 'warning', token: ++this.#token, deadline: now + this.warningMs };
    return { ...this.#warning };
  }
  confirm(token, now) {
    const state = this.evaluate(now);
    if (state.type !== 'warning' || state.token !== token || now < state.deadline) return false;
    this.#finished = true; this.#warning = undefined;
    return true;
  }
  pause() { this.#paused = true; this.#sources.clear(); this.#warning = undefined; }
  resume() { this.#paused = false; this.#sources.clear(); this.#warning = undefined; }
  extend(now) {
    if (!Number.isFinite(now) || now < 0) throw new Error('invalid monotonic time');
    this.#warning = undefined;
    for (const source of this.#sources.values()) source.silentSince = source.healthy && !source.speech ? Math.max(now, source.at) : undefined;
  }
}
