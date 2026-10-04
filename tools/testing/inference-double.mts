// Standalone browser helper: pass to page.evaluate after defining
// globalThis.inferenceHandlers, or supply handlers explicitly in a JS realm.
// Only computation is replaced; this does not test native Worker/model quality.
export function installInferenceDouble({ handlers = globalThis.inferenceHandlers,
  workerUrl = 'omn://app/inference-worker.mjs', errorCodes = ['OUTPUT_LIMIT', 'CONTEXT_LIMIT'] } = {}) {
  if (!handlers || typeof handlers !== 'object') throw new Error('inference handlers required');
  if (typeof workerUrl !== 'string' || !workerUrl || !Array.isArray(errorCodes) || errorCodes.some(code => typeof code !== 'string'))
    throw new Error('invalid worker URL or error codes');
  if (globalThis.inferenceDouble?.restore) throw new Error('restore the existing inference double before installing another');
  const originalWorker = globalThis.Worker;
  const state = globalThis.inferenceDouble = { workers: [], requests: [], unexpected: [] };
  globalThis.Worker = class {
    constructor(url, options) {
      if (String(url) !== workerUrl || options?.type !== 'module')
        throw new Error(`unexpected worker: ${url}`);
      this.terminated = false;
      this.busy = false;
      state.workers.push(this);
    }
    postMessage(message) {
      if (this.terminated) throw new Error('test worker terminated');
      if (this.busy) throw new Error('test worker busy');
      const request = structuredClone(message);
      const { id, operation, input } = request;
      if (!Number.isSafeInteger(id) || !Object.hasOwn(handlers, operation) || typeof handlers[operation] !== 'function') {
        const error = `unexpected inference request: ${operation}`;
        state.unexpected.push(error);
        throw new Error(error);
      }
      state.requests.push(request);
      this.busy = true;
      // A task boundary and copies in both directions prevent shared-object or
      // synchronous callbacks from hiding bugs at the real Worker boundary.
      this.timer = setTimeout(async () => {
        let data;
        try {
          const result = await handlers[operation](input);
          data = structuredClone({ id, type: 'result', result });
        } catch (error) {
          data = { id, type: 'error', message: error.message,
            ...(errorCodes.includes(error.code) ? { code: error.code } : {}) };
        }
        this.busy = false;
        if (!this.terminated) this.onmessage?.({ data });
      }, 0);
    }
    terminate() { this.terminated = true; clearTimeout(this.timer); }
  };
  const installedWorker = globalThis.Worker;
  state.restore = () => {
    for (const worker of state.workers) worker.terminate();
    if (globalThis.Worker === installedWorker) globalThis.Worker = originalWorker;
    if (globalThis.inferenceDouble === state) delete globalThis.inferenceDouble;
  };
}
