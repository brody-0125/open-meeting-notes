import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// External development verification, not signing or runtime tamper protection.
// The approved hash must arrive independently of this package. Keep the package
// read-only throughout verification and use; concurrent hostile writes are outside this check.
export async function verifyDevelopmentPackage({ root, approvedManifestHash }) {
  if (!validHash(approvedManifestHash)) throw new Error('approved manifest hash required');
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('package root link or invalid directory');
  const manifestPath = join(root, 'build-manifest.json'), manifestStat = await lstat(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error('manifest link or invalid file');
  const handle = await open(manifestPath, 'r'); let bytes;
  try {
    if ((await handle.stat()).size > 4 * 1024 * 1024) throw new Error('manifest too large');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (createHash('sha256').update(bytes).digest('hex') !== approvedManifestHash) throw new Error('manifest integrity mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!exact(manifest, ['version', 'appVersion', 'electronVersion', 'platform', 'signed', 'files']) ||
      manifest.version !== 1 || manifest.platform !== 'win32-x64' || manifest.signed !== false ||
      ![manifest.appVersion, manifest.electronVersion].every(v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v)) ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000) throw new Error('invalid development manifest');
  const expected = new Map(), names = new Set(), directories = new Set();
  for (const file of manifest.files) {
    if (!exact(file, ['path', 'bytes', 'sha256']) || !validHash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('invalid manifest file');
    const parts = typeof file.path === 'string' && file.path.length <= 512 ? file.path.split('/') : [];
    if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || /[<>:"\\|?*\x00-\x1f]/.test(p) ||
        /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) ||
        file.path.toLowerCase() === 'build-manifest.json') throw new Error('unsafe package path');
    const key = file.path.toLowerCase();
    if (names.has(key)) throw new Error('duplicate package path');
    names.add(key); expected.set(file.path, file);
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const seen = new Set();
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name, absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('package link denied');
      if (entry.isDirectory()) {
        if (!directories.has(path)) throw new Error(`unlisted package directory: ${path}`);
        await inspect(absolute, `${path}/`);
      } else if (entry.isFile()) {
        if (path === 'build-manifest.json') continue;
        const file = expected.get(path);
        if (!file) throw new Error(`unlisted package file: ${path}`);
        const input = await open(absolute, 'r');
        try {
          if ((await input.stat()).size !== file.bytes) throw new Error(`package integrity mismatch: ${path}`);
          const hash = createHash('sha256'); let count = 0;
          for await (const chunk of input.createReadStream({ autoClose: false })) { hash.update(chunk); count += chunk.length; }
          if (count !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`package integrity mismatch: ${path}`);
        } finally { await input.close(); }
        seen.add(path);
      } else throw new Error('invalid package entry');
    }
  }
  await inspect(root);
  if (seen.size !== expected.size) throw new Error('missing package file');
  return manifest;
}
