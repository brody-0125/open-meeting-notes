// Renderer coordinator. Main must already have accepted session consent.
// Ports are dedicated to this capture; sink is a narrow preload bridge.
export class CaptureDrain {
  #state = 'idle';
  #ports;
  #sink;
  #cutoffs = {};
  #pending = new Set();
  #timer;
  #resolve;
  #reject;
  #committing = false;
  #pause;
  #resume;
  constructor(ports, sink, { stopTimeoutMs = 15000, finalizeTimeoutMs = 300000, maxPendingChunks = 16, onDrained = async () => {} } = {}) {
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs <= 0 || !Number.isSafeInteger(finalizeTimeoutMs) || finalizeTimeoutMs <= 0 || !Number.isSafeInteger(maxPendingChunks) || maxPendingChunks < 1 || typeof onDrained !== 'function') throw new Error('invalid drain limits');
    for (const source of ['microphone', 'remote']) if (typeof ports?.[source]?.postMessage !== 'function') throw new Error('two capture ports required');
    for (const method of ['append', 'stop', 'finish', 'abort']) if (typeof sink?.[method] !== 'function') throw new Error('incomplete capture sink');
    this.#ports = { microphone: ports.microphone, remote: ports.remote };
    this.#sink = sink;
    this.stopTimeoutMs = stopTimeoutMs;
    this.finalizeTimeoutMs = finalizeTimeoutMs;
    this.onDrained = onDrained;
    this.maxPendingChunks = maxPendingChunks;
    this.done = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    // A failure during recording remains observable without an unhandled promise.
    this.done.catch(() => {});
    for (const [source, port] of Object.entries(this.#ports)) port.onmessage = ({ data }) => this.#message(source, data);
  }
  get state() { return this.#state; }
  start() {
    if (this.#state !== 'idle') throw new Error('capture already started');
    this.#state = 'recording';
    try { for (const port of Object.values(this.#ports)) port.postMessage({ type: 'start' }); }
    catch (error) { this.fail(error); throw error; }
  }
  pause() {
    if (this.#state !== 'recording' || typeof this.#sink.pause !== 'function') throw new Error('capture pause unavailable');
    this.#resume = undefined;
    const request = this.#pause = { id: (this.#pause?.id ?? 0) + 1, cutoffs: {}, committing: false };
    request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    request.promise.catch(() => {});
    this.#state = 'pausing';
    this.#timer = setTimeout(() => this.fail(new Error('capture pause timeout; recording incomplete')), this.stopTimeoutMs);
    try { for (const port of Object.values(this.#ports)) port.postMessage({ type: 'pause', pauseId: request.id }); }
    catch (error) { this.fail(error); }
    return request.promise;
  }
  resume() {
    if (this.#state !== 'paused' || typeof this.#sink.resume !== 'function') throw new Error('capture resume unavailable');
    const request = this.#resume = { id: this.#pause.id, starts: {}, committing: false };
    request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    const settled = request.promise.then(() => {}, error => this.fail(error)).finally(() => {
      this.#pending.delete(settled); this.#finishIfReady();
    });
    this.#pending.add(settled);
    this.#state = 'resuming';
    this.#timer = setTimeout(() => this.fail(new Error('capture resume timeout; recording incomplete')), this.stopTimeoutMs);
    try { for (const port of Object.values(this.#ports)) port.postMessage({ type: 'resume', pauseId: request.id }); }
    catch (error) { this.fail(error); }
    const result = request.promise.then(record => {
      if (this.#state !== 'recording') throw new Error('capture stopped during resume');
      return record;
    });
    result.catch(() => {}); return result;
  }
  stop() {
    if (this.#state === 'idle') throw new Error('capture not started');
    if (['recording', 'pausing', 'paused', 'resuming'].includes(this.#state)) {
      this.#pause?.reject(new Error('capture stopped during pause'));
      clearTimeout(this.#timer);
      this.#state = 'draining';
      this.#timer = setTimeout(() => this.fail(new Error('capture drain timeout; recording incomplete')), this.stopTimeoutMs);
      try { for (const port of Object.values(this.#ports)) port.postMessage({ type: 'stop' }); }
      catch (error) { this.fail(error); }
    }
    return this.done;
  }
  fail(error) {
    if (['stopped', 'failed'].includes(this.#state)) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#state = 'failed';
    this.#pause?.reject(failure);
    this.#resume?.reject(failure);
    for (const port of Object.values(this.#ports)) {
      try { port.postMessage({ type: 'stop' }); } catch { /* Other source still stops. */ }
    }
    this.#detach();
    // Main must mark this recording incomplete even if some writes finish later.
    try { Promise.resolve(this.#sink.abort(failure.message)).catch(() => {}); } catch { /* Preserve original failure. */ }
    this.#reject(failure);
  }
  #message(source, data) {
    if (['stopped', 'failed'].includes(this.#state)) return;
    try {
      if (data?.type === 'capture-error') throw new Error(data.message || 'capture processor failed');
      if (!['recording', 'pausing', 'paused', 'resuming', 'draining'].includes(this.#state)) throw new Error('capture data before start');
      if (data?.type === 'resumed') {
        const request = this.#resume;
        if (!request || !['resuming', 'draining'].includes(this.#state) || data.pauseId !== request.id ||
            Object.hasOwn(request.starts, source) || Object.hasOwn(this.#cutoffs, source) ||
            !Number.isSafeInteger(data.startFrame) || data.startFrame < this.#pause.cutoffs[source]) throw new Error('invalid capture resume boundary');
        request.starts[source] = data.startFrame;
        this.#resumeIfReady(); return;
      }
      if (data?.type === 'paused') {
        const request = this.#pause;
        if (!request || !['pausing', 'draining'].includes(this.#state) || data.pauseId !== request.id ||
            Object.hasOwn(request.cutoffs, source) || Object.hasOwn(this.#cutoffs, source) ||
            !Number.isSafeInteger(data.cutoff) || data.cutoff < 0) throw new Error('invalid capture pause boundary');
        request.cutoffs[source] = data.cutoff;
        this.#pauseIfReady();
        return;
      }
      if (data?.type === 'stopped') {
        if (this.#state !== 'draining' || Object.hasOwn(this.#cutoffs, source) || !Number.isSafeInteger(data.cutoff) || data.cutoff < 0) throw new Error('invalid capture cutoff');
        this.#cutoffs[source] = data.cutoff;
        this.#finishIfReady();
        return;
      }
      if (data?.type !== 'chunk' || data.meta?.source !== source || Object.hasOwn(this.#cutoffs, source) ||
          this.#pause && Object.hasOwn(this.#pause.cutoffs, source) && !Object.hasOwn(this.#resume?.starts ?? {}, source)) throw new Error('invalid capture source or late tail');
      if (this.#pending.size >= this.maxPendingChunks) throw new Error('capture drain queue exceeded');
      const seq = data.meta.seq;
      const gate = this.#resume?.promise;
      const write = Promise.resolve().then(async () => {
        await gate;
        if (this.#state === 'failed') throw new Error('capture failed before append');
        return this.#sink.append(data);
      }).then(ack => {
        if (ack?.durable !== true) throw new Error('missing durable ACK');
        if (this.#state !== 'failed') this.#ports[source].postMessage({ type: 'ack', seq });
      }).catch(error => this.fail(error)).finally(() => {
        this.#pending.delete(write);
        this.#pauseIfReady();
        this.#finishIfReady();
      });
      this.#pending.add(write);
    } catch (error) { this.fail(error); }
  }
  #resumeIfReady() {
    const request = this.#resume;
    if (request.committing || Object.keys(request.starts).length !== 2) return;
    request.committing = true;
    const record = { pauseId: request.id, starts: { ...request.starts } };
    Promise.resolve().then(async () => {
      if (this.#state === 'failed') return;
      const ack = await this.#sink.resume(structuredClone(record));
      if (this.#state === 'failed') return;
      if (ack?.durable !== true) throw new Error('missing durable resume ACK');
      if (this.#state === 'resuming') {
        clearTimeout(this.#timer); this.#state = 'recording';
      }
      request.resolve(record);
    }).catch(error => this.fail(error));
  }
  #pauseIfReady() {
    const request = this.#pause;
    if (this.#state !== 'pausing' || request.committing || this.#pending.size || Object.keys(request.cutoffs).length !== 2) return;
    request.committing = true;
    const record = { pauseId: request.id, cutoffs: { ...request.cutoffs } };
    const write = Promise.resolve().then(async () => {
      if (this.#state !== 'pausing') return;
      const ack = await this.#sink.pause(structuredClone(record));
      if (ack?.durable !== true) throw new Error('missing durable pause ACK');
      if (this.#state !== 'pausing') return;
      clearTimeout(this.#timer);
      this.#state = 'paused';
      request.resolve(record);
    }).catch(error => this.fail(error)).finally(() => {
      this.#pending.delete(write);
      this.#finishIfReady();
    });
    this.#pending.add(write);
  }
  #finishIfReady() {
    if (this.#state !== 'draining' || this.#committing || this.#pending.size || Object.keys(this.#cutoffs).length !== 2) return;
    this.#committing = true;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      const error = new Error('recording finalization timeout; completion must be checked from storage');
      error.code = 'FINALIZATION_TIMEOUT';
      this.fail(error);
    }, this.finalizeTimeoutMs);
    const cutoffs = { microphone: this.#cutoffs.microphone, remote: this.#cutoffs.remote };
    Promise.resolve().then(async () => {
      if (this.#state !== 'draining') return;
      await this.onDrained();
      if (this.#state !== 'draining') return;
      await this.#sink.stop(cutoffs);
      if (this.#state !== 'draining') return;
      await this.#sink.finish();
      if (this.#state !== 'draining') return;
      this.#state = 'stopped';
      this.#detach();
      this.#resolve(cutoffs);
    }).catch(error => this.fail(error));
  }
  #detach() {
    clearTimeout(this.#timer);
    for (const port of Object.values(this.#ports)) port.onmessage = null;
  }
}
