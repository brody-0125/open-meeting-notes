import { lstat, open, realpath } from 'node:fs/promises';
import { join, isAbsolute, parse } from 'node:path';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
function localRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || /^[\\/]{2}/.test(root) ||
      root.split(/[\\/]/).some(part => part === '.' || part === '..') ||
      process.platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(root)) throw new Error('absolute local model path required');
}
async function localDirectory(root) {
  localRoot(root);
  let target = parse(root).root;
  const paths = [target];
  for (const part of root.slice(target.length).split(/[\\/]/).filter(Boolean)) {
    target = join(target, part); paths.push(target);
  }
  // Inspect each ancestor before accessing its children. Installation directories
  // must remain immutable; this is not an OS-level race-free filesystem sandbox.
  for (const path of paths) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('model directory link denied');
    if (!stat.isDirectory()) throw new Error('invalid model directory');
  }
}
function exact(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
    Object.keys(object).length !== keys.length || keys.some(k => !Object.hasOwn(object, k))) throw new Error('invalid manifest fields');
}
function validatePath(path) {
  if (typeof path !== 'string' || path.length > 240 || !path.split('/').every(part =>
    /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) && !part.endsWith('.') &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('unsafe asset path');
}
async function regularFile(root, path) {
  let target = root;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    target = join(target, parts[i]);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error('asset link denied');
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('invalid asset type');
  }
  return target;
}

// Read exactly the approved length into an owned buffer, then hash the bytes
// that will be served. A changed file cannot inherit its old model identity.
export async function readVerifiedModelAsset(pack, file) {
  await localDirectory(pack.root);
  const input = await open(await regularFile(pack.root, file.path), 'r');
  try {
    if ((await input.stat()).size !== file.bytes) throw new Error('asset size mismatch');
    const bytes = Buffer.alloc(file.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await input.read(bytes, offset, bytes.length - offset, offset);
      if (!part.bytesRead) throw new Error('asset size mismatch');
      offset += part.bytesRead;
    }
    if ((await input.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || sha(bytes) !== file.sha256) throw new Error('asset integrity mismatch');
    return bytes;
  } finally { await input.close(); }
}

// The approved hash must come from trusted application/installation metadata,
// never from another untrusted file placed alongside the model pack.
// Pack directory must remain read-only during verification AND inference.
export async function verifyModelPack({ root, approvedManifestHash, engine, engineVersion }) {
  if (!validHash(approvedManifestHash)) throw new Error('approved manifest hash required');
  await localDirectory(root);
  const directory = await realpath(root);
  localRoot(directory);
  const manifestPath = await regularFile(directory, 'manifest.json');
  const handle = await open(manifestPath, 'r');
  let bytes;
  try {
    if ((await handle.stat()).size > 1024 * 1024) throw new Error('manifest too large');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (sha(bytes) !== approvedManifestHash) throw new Error('manifest integrity mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  exact(manifest, ['version', 'id', 'engine', 'engineVersion', 'files']);
  if (manifest.version !== 1 || typeof manifest.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(manifest.id)) throw new Error('unsupported manifest');
  if (!['transformers', 'webllm', 'silero'].includes(engine) || manifest.engine !== engine || typeof engineVersion !== 'string' || manifest.engineVersion !== engineVersion) throw new Error('incompatible engine');
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 4096) throw new Error('invalid asset count');
  const paths = new Set(), roles = new Set();
  for (const file of manifest.files) {
    exact(file, ['path', 'role', 'bytes', 'sha256']);
    validatePath(file.path);
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error('duplicate asset path');
    paths.add(key);
    if (!['weights', 'tokenizer', 'config', 'runtime'].includes(file.role) || !validHash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1) throw new Error('invalid asset descriptor');
    roles.add(file.role);
  }
  for (const role of engine === 'silero' ? ['weights', 'runtime'] : ['weights', 'tokenizer', 'config', 'runtime']) if (!roles.has(role)) throw new Error(`missing ${role} asset`);
  for (const file of manifest.files) {
    const path = await regularFile(directory, file.path);
    const input = await open(path, 'r');
    try {
      if ((await input.stat()).size !== file.bytes) throw new Error(`asset size mismatch: ${file.path}`);
      const hash = createHash('sha256');
      let size = 0;
      for await (const block of input.createReadStream({ autoClose: false })) { size += block.length; hash.update(block); }
      if (size !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`asset integrity mismatch: ${file.path}`);
    } finally { await input.close(); }
  }
  return Object.freeze({ id: manifest.id, engine, engineVersion, root: directory,
    manifestHash: approvedManifestHash, files: Object.freeze(manifest.files.map(f => Object.freeze({ ...f }))) });
}
