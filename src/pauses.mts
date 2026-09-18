import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';

const sources = ['microphone', 'remote'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) throw new Error('invalid pause fields');
}
function frames(value) {
  exact(value, sources);
  if (sources.some(source => !Number.isSafeInteger(value[source]) || value[source] < 0)) throw new Error('invalid pause frames');
  return { microphone: value.microphone, remote: value.remote };
}
export function validatePauses(pauses) {
  if (!Array.isArray(pauses) || pauses.length > 10000) throw new Error('invalid pause count');
  let previous = { microphone: 0, remote: 0 };
  for (const [index, pause] of pauses.entries()) {
    exact(pause, ['pauseId', 'cutoffs', 'starts']);
    if (pause.pauseId !== index + 1) throw new Error('invalid pause sequence');
    frames(pause.cutoffs);
    if (sources.some(source => pause.cutoffs[source] < previous[source])) throw new Error('invalid pause timeline');
    if (pause.starts === null) {
      if (index !== pauses.length - 1) throw new Error('open pause');
    } else {
      frames(pause.starts);
      if (sources.some(source => pause.starts[source] < pause.cutoffs[source])) throw new Error('invalid pause timeline');
      previous = pause.starts;
    }
  }
}

// One Main-process owner per recording. Hashes detect corruption, not forgery.
// Main must separately match these boundaries to approved actions and audio ACKs.
export class PauseStore {
  #pending = Promise.resolve();
  constructor(root, sessionId, { checkpoint = async () => {} } = {}) {
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(sessionId)) throw new Error('invalid pause session');
    this.root = root; this.sessionId = sessionId; this.checkpoint = checkpoint;
  }
  async #read() {
    try {
      const root = await lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unsafe pause directory');
      const path = join(this.root, 'pauses.json'), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('unsafe pause file');
      const { checksum, ...body } = JSON.parse(await readFile(path, 'utf8'));
      if (checksum !== hash(body)) throw new Error('pause integrity mismatch');
      exact(body, ['version', 'sessionId', 'pauses']);
      if (body.version !== 1 || body.sessionId !== this.sessionId) throw new Error('invalid pause session or version');
      validatePauses(body.pauses); return body.pauses;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async read() { await this.#pending; return this.#read(); }
  pause(record) { return this.#save('pause', record); }
  resume(record) { return this.#save('resume', record); }
  #save(operation, input) {
    const snapshot = structuredClone(input);
    const task = this.#pending.then(async () => {
      const field = operation === 'pause' ? 'cutoffs' : 'starts';
      exact(snapshot, ['pauseId', field]);
      const { pauseId } = snapshot, boundary = frames(snapshot[field]);
      if (!Number.isSafeInteger(pauseId) || pauseId < 1 || pauseId > 10000) throw new Error('invalid pause ID');
      const pauses = await this.#read(), existing = pauses[pauseId - 1];
      if (existing && (operation === 'pause' || existing.starts !== null)) {
        if (sources.some(source => existing[field][source] !== boundary[source])) throw new Error('pause conflict');
        return { durable: true };
      }
      if (operation === 'pause') {
        if (pauseId !== pauses.length + 1) throw new Error('invalid pause sequence');
        if (pauses.at(-1)?.starts === null) throw new Error('open pause');
        pauses.push({ pauseId, cutoffs: boundary, starts: null });
      } else {
        if (!existing || pauseId !== pauses.length) throw new Error('unknown resume target');
        existing.starts = boundary;
      }
      validatePauses(pauses);
      const body = { version: 1, sessionId: this.sessionId, pauses };
      const bytes = JSON.stringify({ ...body, checksum: hash(body) });
      if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('pause record too large');
      await mkdir(this.root, { recursive: true });
      const root = await lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unsafe pause directory');
      const temp = join(this.root, `.pauses-${randomUUID()}.partial`), file = await open(temp, 'wx');
      try {
        await file.writeFile(bytes); await this.checkpoint('written');
        await file.sync(); await this.checkpoint('synced');
      } finally { await file.close(); }
      await rename(temp, join(this.root, 'pauses.json')); await this.checkpoint('renamed');
      if (process.platform !== 'win32') {
        const directory = await open(this.root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      await this.checkpoint('committed');
      return { durable: true };
    });
    this.#pending = task.catch(() => {}); return task;
  }
}
