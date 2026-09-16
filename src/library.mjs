import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectRecording } from './recording-seal.mjs';
const validId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);

// Trusted application root; directories must not be replaced during inspection.
export class RecordingLibrary {
  constructor(root) { this.root = root; }
  async directory(id) {
    if (!validId(id)) throw new Error('invalid recording id');
    const path = join(this.root, id);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe recording directory');
    return { path, stat };
  }
  async list() {
    const entries = [];
    for (const id of await readdir(this.root)) {
      if (!validId(id)) continue;
      try {
        const { stat } = await this.directory(id);
        entries.push({ id, modifiedAt: stat.mtime.toISOString() });
      } catch (error) { if (error.code !== 'ENOENT' && error.message !== 'unsafe recording directory') throw error; }
    }
    return entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id)).slice(0, 50);
  }
  async inspect(id) {
    const { path } = await this.directory(id);
    const result = await inspectRecording(path);
    if (result.state !== 'complete') return { id, state: result.state };
    if (result.sessionId !== id) return { id, state: 'damaged' };
    const durationSeconds = Math.max(...['microphone', 'remote'].map(source => result.formats[source] ? result.cutoffs[source] / result.formats[source].sampleRate : 0));
    return { id, state: 'complete', durationSeconds, chunks: result.chunks };
  }
}
