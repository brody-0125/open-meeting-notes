import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function original(transcript) {
  const { baseHash, ...base } = structuredClone(transcript);
  base.revision = 1;
  base.segments = base.segments.map(({ originalRawText, speechReview, ...segment }) => ({ ...segment, rawText: originalRawText ?? segment.rawText }));
  return base;
}
// One Main owner serializes saves. Generated per-job transcripts remain immutable.
export class CorrectionStore {
  constructor(root) { this.root = root; }
  async load(transcript) {
    const base = original(transcript), key = hash(base);
    let record = { version: 1, key, revision: 1, edits: {} };
    try {
      const rootStat = await lstat(this.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe corrections directory');
      const path = join(this.root, `${key}.json`), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('unsafe corrections file');
      const { checksum, ...body } = JSON.parse(await readFile(path, 'utf8'));
      if (body.version !== 1 || body.key !== key || !Number.isSafeInteger(body.revision) || body.revision < 2 ||
          !body.edits || Array.isArray(body.edits) || typeof body.edits !== 'object' || checksum !== hash(body)) throw new Error('corrections integrity mismatch');
      record = body;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ids = new Set(base.segments.map(s => s.id));
    for (const [id, text] of Object.entries(record.edits)) if (!ids.has(id) || typeof text !== 'string' || text.length > 12000) throw new Error('invalid correction');
    return { ...base, baseHash: key, revision: record.revision, segments: base.segments.map(s => Object.hasOwn(record.edits, s.id)
      ? { ...s, originalRawText: s.rawText, rawText: record.edits[s.id] } : s) };
  }
  async save(transcript, segmentId, text) {
    if (typeof text !== 'string' || text.length > 12000 || !transcript.segments.some(s => s.id === segmentId)) throw new Error('invalid correction');
    const current = await this.load(transcript);
    if (current.revision !== transcript.revision || current.baseHash !== transcript.baseHash) throw new Error('stale transcript revision');
    if (current.segments.find(s => s.id === segmentId).rawText === text) return current;
    if (!Number.isSafeInteger(current.revision + 1)) throw new Error('revision overflow');
    const edits = Object.fromEntries(current.segments.filter(s => s.originalRawText !== undefined).map(s => [s.id, s.rawText]));
    edits[segmentId] = text;
    const body = { version: 1, key: current.baseHash, revision: current.revision + 1, edits };
    const bytes = JSON.stringify({ ...body, checksum: hash(body) });
    if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('corrections too large');
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, `${current.baseHash}.json`), temporary = `${path}.${randomUUID()}.partial`;
    const file = await open(temporary, 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') { const dir = await open(this.root, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    return this.load(transcript);
  }
}
