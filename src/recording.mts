import { randomUUID } from 'node:crypto';
import { Session } from './contracts.mjs';
import { PauseStore } from './pauses.mjs';

// Main owns this controller. Never expose the object or consent issuer directly
// over IPC; the approved UI action must be checked at that boundary.
export class Recording {
  #consent;
  #session;
  #writes = new Set();
  #streams = new Map();
  #sealed = false;
  #error;
  #bytes = 0;
  #pauseState;
  #pauseId = 0;
  constructor(id, store, { maxPendingBytes = 8 * 1024 * 1024, pauseStore } = {}) {
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) throw new Error('invalid queue limit');
    this.#session = new Session(id);
    this.store = store;
    this.pauseStore = pauseStore ?? (store.root ? new PauseStore(store.root, id) : undefined);
    this.maxPendingBytes = maxPendingBytes;
  }
  get state() { return this.#error ? 'failed' : this.#pauseState ?? this.#session.state; }
  get pendingBytes() { return this.#bytes; }
  abort(reason) {
    if (this.state === 'stopped') throw new Error('recording already completed');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new Error('invalid abort reason');
    this.#error ??= new Error(`capture incomplete: ${reason}`);
    this.#sealed = true;
    this.#consent = undefined;
  }
  requestConsent() {
    if (this.state !== 'idle') throw new Error('session already started');
    return (this.#consent = randomUUID());
  }
  start(token) {
    if (!this.#consent || token !== this.#consent) throw new Error('invalid consent');
    this.#session.start(true);
    this.#consent = undefined;
  }
  stop(cutoffs) {
    if (this.#error) throw this.#error;
    if (['pausing', 'resuming'].includes(this.#pauseState)) throw new Error('pause transition pending');
    if (this.#pauseState === 'paused' && ['microphone', 'remote'].some(source =>
      cutoffs?.[source] !== (this.#streams.get(source)?.frame ?? 0))) throw new Error('stop differs from pause boundary');
    for (const [source, stream] of this.#streams) {
      if (!cutoffs || cutoffs[source] < stream.frame) throw new Error('cutoff precedes received frames');
    }
    this.#session.stop(cutoffs);
    this.#pauseState = undefined;
  }
  async pause(record) {
    if (this.state !== 'recording' || !this.pauseStore) throw new Error('recording pause unavailable');
    const boundary = this.#pauseBoundary(record, 'cutoffs', this.#pauseId + 1);
    if (Object.entries(boundary).some(([source, frame]) => frame !== (this.#streams.get(source)?.frame ?? 0)))
      throw new Error('pause boundary differs from received audio');
    const pauseId = record.pauseId;
    this.#pauseState = 'pausing';
    try {
      await Promise.all(this.#writes);
      if (this.#error) throw this.#error;
      const ack = await this.pauseStore.pause({ pauseId, cutoffs: boundary });
      if (this.#error) throw this.#error;
      if (ack?.durable !== true) throw new Error('missing durable pause ACK');
      this.#pauseId = pauseId; this.#pauseState = 'paused';
      return ack;
    } catch (error) { this.#error ??= error; throw this.#error; }
  }
  async resume(record) {
    if (this.state !== 'paused') throw new Error('recording resume unavailable');
    const boundary = this.#pauseBoundary(record, 'starts', this.#pauseId);
    if (Object.entries(boundary).some(([source, frame]) => frame < (this.#streams.get(source)?.frame ?? 0)))
      throw new Error('resume boundary precedes audio');
    this.#pauseState = 'resuming';
    try {
      const ack = await this.pauseStore.resume({ pauseId: this.#pauseId, starts: boundary });
      if (this.#error) throw this.#error;
      if (ack?.durable !== true) throw new Error('missing durable resume ACK');
      for (const [source, frame] of Object.entries(boundary))
        this.#streams.set(source, { seq: 0, ...this.#streams.get(source), frame });
      this.#pauseState = undefined;
      return ack;
    } catch (error) { this.#error ??= error; throw this.#error; }
  }
  #pauseBoundary(record, field, expectedId) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 2 || !Object.hasOwn(record, field) ||
        !Number.isSafeInteger(record.pauseId) || record.pauseId !== expectedId || record.pauseId < 1 || record.pauseId > 10000)
      throw new Error('invalid pause/resume request');
    const value = record[field];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !['microphone', 'remote'].every(source =>
      Object.hasOwn(value, source) && Number.isSafeInteger(value[source]) && value[source] >= 0)) throw new Error('invalid pause boundary');
    return { microphone: value.microphone, remote: value.remote };
  }
  async append(meta, pcm) {
    if (this.#error) throw this.#error;
    if (this.#pauseState) throw new Error('capture paused or transition pending');
    if (this.#sealed) throw new Error('capture is closed');
    this.#session.accept(meta, pcm);
    if (meta.epoch !== 0) throw new Error('unsupported capture epoch');
    const previous = this.#streams.get(meta.source) ?? { seq: 0, frame: 0 };
    if (meta.seq !== previous.seq) throw new Error('non-contiguous sequence');
    if (meta.startFrame !== previous.frame) throw new Error('non-contiguous frame');
    if (previous.sampleRate && (meta.sampleRate !== previous.sampleRate || meta.channels !== previous.channels)) throw new Error('capture format changed');
    if (this.#bytes + pcm.byteLength > this.maxPendingBytes) {
      this.#error = new Error('capture queue limit exceeded; recording incomplete');
      throw this.#error;
    }
    const bytes = Buffer.from(pcm);
    const metadata = { ...meta };
    this.#bytes += bytes.length;
    this.#streams.set(meta.source, { seq: meta.seq + 1, frame: meta.startFrame + meta.frames, sampleRate: meta.sampleRate, channels: meta.channels });
    // Track a resolved settlement so failures are never unhandled internally;
    // the original rejection is still returned to the caller.
    const write = Promise.resolve().then(() => this.store.put(metadata, bytes)).then(ack => {
      if (ack?.durable !== true) throw new Error('missing durable ACK');
      return ack;
    });
    const settled = write.then(() => {}, error => { this.#error ??= error; }).finally(() => {
      this.#bytes -= bytes.length;
      this.#writes.delete(settled);
    });
    this.#writes.add(settled);
    try { return await write; } finally { await settled; }
  }
  async finish() {
    if (this.#error) throw new Error(`recording failed: ${this.#error.message}`);
    if (this.#session.state !== 'draining' || this.#sealed) throw new Error('not draining');
    // Capture must deliver its final messages before invoking this method.
    this.#sealed = true;
    await Promise.all(this.#writes);
    if (this.#error) throw new Error(`recording failed: ${this.#error.message}`);
    for (const [source, cutoff] of Object.entries(this.#session.cutoffs)) {
      if ((this.#streams.get(source)?.frame ?? 0) !== cutoff) {
        this.#error = new Error(`missing tail for ${source}`);
        throw this.#error;
      }
    }
    this.#session.finish();
  }
}
