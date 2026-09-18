import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { summaryGroups } from './summary-groups.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyValid = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
export const reviewStates = ['candidate', 'accepted', 'rejected'];

export function speechReviewKey(transcript, segment) {
  if (!keyValid(transcript.baseHash) || !Number.isSafeInteger(transcript.revision) || transcript.revision < 1 ||
      typeof segment.id !== 'string' || typeof segment.rawText !== 'string' || !segment.flags?.includes('speech-unconfirmed'))
    throw new Error('invalid speech review target');
  return hash({ kind: 'speech-review-v1', baseHash: transcript.baseHash, revision: transcript.revision,
    id: segment.id, text: segment.rawText });
}

// User decisions overlay generated candidates. Changed content/model gets new keys.
export function reviewKeys(result, modelHash) {
  if (!keyValid(modelHash)) throw new Error('invalid review model');
  const reconciled = result.reconciliation?.state === 'complete';
  const groups = summaryGroups(result);
  const inputHash = hash({ transcript: result.transcript, modelHash });
  return groups.map(group => {
    const groupHash = hash({ inputHash, part: group.index, summary: group.summary, ...(reconciled ? { stage: 'reconciled' } : {}) });
    return group.summary.items.map((_item, index) => hash({ groupHash, index }));
  });
}

// One Main owner serializes updates. Root is the app-owned recording directory.
export class ReviewStore {
  constructor(root) { this.root = root; }
  async get(key) {
    if (!keyValid(key)) throw new Error('invalid review key');
    try {
      const rootStat = await lstat(this.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe review directory');
      const path = join(this.root, `${key}.json`), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('unsafe review file');
      const { checksum, ...body } = JSON.parse(await readFile(path, 'utf8'));
      if (body.version !== 1 || body.key !== key || !reviewStates.includes(body.state) || checksum !== hash(body)) throw new Error('review integrity mismatch');
      return body.state;
    } catch (error) { if (error.code === 'ENOENT') return 'candidate'; throw error; }
  }
  async set(key, state) {
    if (!keyValid(key) || !reviewStates.includes(state)) throw new Error('invalid review decision');
    await mkdir(this.root, { recursive: true });
    await this.get(key); // Do not overwrite a corrupt or linked existing record.
    const body = { version: 1, key, state }, path = join(this.root, `${key}.json`);
    const temporary = `${path}.${randomUUID()}.partial`, file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify({ ...body, checksum: hash(body) })); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') { const dir = await open(this.root, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    return state;
  }
}
