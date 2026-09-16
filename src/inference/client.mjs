export class InferenceClient {
  #worker;
  #active;
  #nextId = 0;
  #disposed = false;
  constructor(createWorker = () => new Worker('omn://app/inference-worker.mjs', { type: 'module' })) {
    this.createWorker = createWorker;
  }
  async run(operation, input, { signal } = {}) {
    if (this.#disposed) throw new Error('inference client disposed');
    if (this.#active) throw new Error('inference worker busy');
    if (!['transcribe', 'summarize', 'plan-summary', 'plan-reconciliation', 'group-reconciliation', 'reconcile', 'vad-load', 'vad', 'measure-speech'].includes(operation)) throw new Error('unknown inference operation');
    signal?.throwIfAborted();
    if (!this.#worker) {
      const worker = this.createWorker();
      this.#worker = worker;
      worker.onmessage = ({ data }) => {
        if (worker !== this.#worker || data?.id !== this.#active?.id) return;
        if (data.type === 'result') this.#settle(null, data.result);
        else if (data.type === 'error') {
          const error = new Error(data.message ?? 'inference failed');
          if (['OUTPUT_LIMIT', 'CONTEXT_LIMIT'].includes(data.code)) {
            error.code = data.code;
            this.#settle(error); // Bounded rejection; next request resets chat.
          } else this.#fail(error);
        }
      };
      worker.onerror = event => { event.preventDefault?.(); if (worker === this.#worker) this.#fail(new Error(event.message ?? 'worker crashed')); };
      worker.onmessageerror = () => { if (worker === this.#worker) this.#fail(new Error('invalid worker message')); };
    }
    return new Promise((resolve, reject) => {
      const abort = () => this.#fail(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      const id = ++this.#nextId;
      this.#active = { id, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      try { this.#worker.postMessage({ id, operation, input }); }
      catch (error) { this.#fail(error); }
    });
  }
  #settle(error, result) {
    const active = this.#active;
    this.#active = undefined;
    if (!active) return;
    active.cleanup();
    if (error) active.reject(error); else active.resolve(result);
  }
  #fail(error) {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#settle(error);
  }
  dispose() { this.#disposed = true; this.#fail(new Error('inference client disposed')); }
}
