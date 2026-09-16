import { mkdir, open, rename, readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateChunk } from './contracts.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = meta => JSON.stringify(Object.fromEntries(Object.keys(meta).sort().map(k => [k, meta[k]])));
const integrity = (meta, pcm) => hash(Buffer.concat([Buffer.from(canonical(meta)), Buffer.from([0]), pcm]));
const name = m => `${m.sessionId}.${m.epoch}.${m.source}.${m.seq}.chunk`;
const maxFileBytes = 48000 * 5 * 2 * 2 + 8200;

function decode(bytes) {
  if (bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'OMN1') throw new Error('invalid chunk header');
  const length = bytes.readUInt32LE(4);
  if (length > 8192 || length + 8 > bytes.length) throw new Error('invalid header length');
  const { meta, checksum } = JSON.parse(bytes.toString('utf8', 8, 8 + length));
  const pcm = bytes.subarray(8 + length);
  validateChunk(meta, pcm);
  if (checksum !== integrity(meta, pcm)) throw new Error('checksum mismatch');
  return { meta, pcm, checksum };
}

// One Main-process owner per directory. Files are self-contained commits: no
// separately updated journal is required to recover acknowledged audio.
export class ChunkStore {
  constructor(root, { checkpoint = async () => {} } = {}) {
    this.root = root;
    this.checkpoint = checkpoint;
    this.pending = Promise.resolve();
  }
  put(meta, pcm) {
    validateChunk(meta, pcm);
    // Snapshot before queueing: caller mutation must not alter the committed data.
    const metadata = { ...meta };
    const bytes = Buffer.from(pcm);
    const task = this.pending.then(() => this.commit(metadata, bytes));
    this.pending = task.catch(() => {});
    return task;
  }
  async read(file) {
    if (typeof file !== 'string' || !/^[a-zA-Z0-9-]{1,80}\.(0|[1-9]\d*)\.(microphone|remote)\.(0|[1-9]\d*)\.chunk$/.test(file)) throw new Error('invalid chunk filename');
    const path = join(this.root, file);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) throw new Error('unsafe chunk file');
    const decoded = decode(await readFile(path));
    if (name(decoded.meta) !== file) throw new Error('filename metadata mismatch');
    return decoded;
  }
  async commit(meta, pcm) {
    await mkdir(this.root, { recursive: true });
    const file = name(meta);
    const checksum = integrity(meta, pcm);
    const ack = { file, checksum, durable: true };
    try {
      const existing = await this.read(file);
      if (existing.checksum !== checksum) throw new Error('chunk conflict');
      return ack;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const header = Buffer.from(JSON.stringify({ meta, checksum }));
    const prefix = Buffer.alloc(8);
    prefix.write('OMN1');
    prefix.writeUInt32LE(header.length, 4);
    const temp = join(this.root, `${file}.${randomUUID()}.partial`);
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(Buffer.concat([prefix, header, pcm]));
      await this.checkpoint('written');
      await handle.sync();
      await this.checkpoint('synced');
    } finally { await handle.close(); }
    await this.checkpoint('closed');
    await rename(temp, join(this.root, file));
    await this.checkpoint('renamed');
    // POSIX directory sync persists the rename. Windows process-crash recovery
    // is tested separately; this does not claim power-loss durability on Windows.
    if (process.platform !== 'win32') {
      const directory = await open(this.root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    await this.checkpoint('committed');
    return ack;
  }
  async index() { return this.recover({ includePcm: false }); }
  async recover({ includePcm = true } = {}) {
    await this.pending;
    await mkdir(this.root, { recursive: true });
    const result = { chunks: [], errors: [], partials: [] };
    for (const file of (await readdir(this.root)).sort()) {
      if (file.endsWith('.partial')) { result.partials.push(file); continue; }
      if (!file.endsWith('.chunk')) continue;
      try {
        const chunk = await this.read(file);
        result.chunks.push(includePcm ? { file, ...chunk } : { file, meta: chunk.meta, checksum: chunk.checksum });
      }
      catch (error) { result.errors.push({ file, message: error.message }); }
    }
    return result;
  }
}
