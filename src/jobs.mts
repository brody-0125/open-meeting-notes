import { mkdir, lstat, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
const fields = ['version', 'sessionId', 'kind', 'revision', 'inputHash', 'modelHash', 'settingsHash'];
const maxBytes = 2 * 1024 * 1024;

export function jobKey(job) {
  if (!job || Object.keys(job).length !== fields.length || fields.some(k => !Object.hasOwn(job, k)) ||
    job.version !== 1 || typeof job.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(job.sessionId) ||
    !['transcribe', 'summarize', 'plan-summary', 'plan-reconciliation', 'reconcile', 'reconcile-window', 'group-reconciliation'].includes(job.kind) || !Number.isSafeInteger(job.revision) || job.revision < 0 ||
    ['inputHash', 'modelHash', 'settingsHash'].some(k => typeof job[k] !== 'string' || !/^[a-f0-9]{64}$/.test(job[k]))) throw new Error('invalid job descriptor');
  return hash(JSON.stringify(Object.fromEntries(fields.map(k => [k, job[k]]))));
}

// One Main-process owner. Running leases are intentionally not recovered:
// only committed results survive restart, and unfinished jobs are retried.
export class JobStore {
  #active = new Map();
  #pending = Promise.resolve();
  constructor(root, { checkpoint = async () => {} } = {}) { this.root = root; this.checkpoint = checkpoint; }
  #enqueue(task) {
    const pending = this.#pending.then(task);
    this.#pending = pending.catch(() => {});
    return pending;
  }
  begin(descriptor) {
    const key = jobKey(descriptor), snapshot = { ...descriptor };
    return this.#enqueue(async () => {
      if (this.#active.has(key)) throw new Error('job already active');
      const file = join(this.root, `${key}.json`);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('unsafe result file');
        const record = JSON.parse(await readFile(file, 'utf8'));
        const { checksum, ...body } = record;
        if (body.version !== 1 || body.key !== key || jobKey(body.descriptor) !== key || checksum !== hash(JSON.stringify(body))) throw new Error('result integrity mismatch');
        return { key, cached: true, result: body.result };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const token = randomUUID();
      this.#active.set(key, { token, descriptor: snapshot });
      return { key, token, cached: false };
    });
  }
  cancel(lease) {
    if (this.#active.get(lease.key)?.token === lease.token) this.#active.delete(lease.key);
  }
  complete(lease, result) {
    // Snapshot now, before async writes; caller mutation cannot alter the commit.
    const snapshot = structuredClone(result);
    return this.#enqueue(async () => {
      const active = this.#active.get(lease.key);
      if (!active || active.token !== lease.token) throw new Error('stale job lease');
      const body = { version: 1, key: lease.key, descriptor: active.descriptor, result: snapshot };
      const json = JSON.stringify(body);
      const bytes = Buffer.from(JSON.stringify({ ...body, checksum: hash(json) }));
      if (bytes.length > maxBytes) throw new Error('result too large');
      await mkdir(this.root, { recursive: true });
      const temp = join(this.root, `${lease.key}.${randomUUID()}.partial`);
      const file = await open(temp, 'wx');
      try { await file.writeFile(bytes); await file.sync(); await this.checkpoint('synced'); }
      finally { await file.close(); }
      if (this.#active.get(lease.key)?.token !== lease.token) throw new Error('stale job lease');
      await rename(temp, join(this.root, `${lease.key}.json`));
      if (process.platform !== 'win32') {
        const directory = await open(this.root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      await this.checkpoint('committed');
      this.cancel(lease);
      return { key: lease.key, durable: true };
    });
  }
}

export async function runJob(store, descriptor, execute, validate, { signal } = {}) {
  if (typeof validate !== 'function') throw new Error('result validator required');
  signal?.throwIfAborted();
  const lease = await store.begin(descriptor);
  const abort = () => store.cancel(lease);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const result = lease.cached ? lease.result : await execute({ key: lease.key, signal });
    signal?.throwIfAborted();
    await validate(result);
    signal?.throwIfAborted();
    if (!lease.cached) await store.complete(lease, result);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!lease.cached) store.cancel(lease);
  }
}
