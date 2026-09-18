import { randomUUID } from 'node:crypto';
export class InferenceChannel {
  #pending;
  constructor(send, { timeoutMs = 300000 } = {}) {
    if (typeof send !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid inference channel');
    this.send = send; this.timeoutMs = timeoutMs;
  }
  async request(operation, input, signal) {
    signal?.throwIfAborted();
    if (this.#pending) throw new Error('inference channel busy');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const settle = (error, result) => {
        if (this.#pending?.id !== id) return;
        this.#pending = undefined; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => settle(new DOMException('Analysis cancelled', 'AbortError'));
      const timer = setTimeout(() => settle(new Error('inference response timeout')), this.timeoutMs);
      this.#pending = { id, settle };
      signal?.addEventListener('abort', abort, { once: true });
      try { this.send({ id, operation, input }); } catch (error) { settle(error); }
    });
  }
  respond(message) {
    if (!this.#pending || message?.id !== this.#pending.id) return false;
    const error = message.error ? new Error(String(message.error).slice(0, 1000)) : null;
    if (error && ['OUTPUT_LIMIT', 'CONTEXT_LIMIT'].includes(message.errorCode)) error.code = message.errorCode;
    this.#pending.settle(error, message.result);
    return true;
  }
}
