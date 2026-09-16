// Explicit developer preparation only. Never imported by app runtime.
import { mkdir, writeFile, readdir, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const root = resolve(process.argv[2] ?? (() => { throw new Error('fixture directory required'); })());
const size = process.argv[3] ?? '4b';
const profiles = {
  '4b': { model: 'Qwen3-4B-q4f16_1', revision: 'a5c9fab855e3ccbdfed2e7e69683d75f30332161', shards: 74, extra: [] },
  '8b': { model: 'Qwen3-8B-q4f16_1', revision: 'b3d55c289eae58f77095f5b68c895eeea358ee09', shards: 113, extra: ['vocab.json', 'merges.txt'] }
};
if (!Object.hasOwn(profiles, size)) throw new Error('supported fixtures: 4b, 8b');
const { model, revision, shards, extra } = profiles[size];
const runtimeRevision = '025bcaf3780fa8254f5e5efd3bfea0a5397248f4';
await mkdir(root, { recursive: true });
if ((await readdir(root)).length) throw new Error('fixture directory must be empty; existing packs are never overwritten');
const names = ['mlc-chat-config.json', 'ndarray-cache.json', 'tensor-cache.json', 'tokenizer.json', 'tokenizer_config.json', ...extra,
  ...Array.from({ length: shards }, (_, i) => `params_shard_${i}.bin`)];
const files = [];
let cursor = 0;
async function download(url, path, role) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const hash = createHash('sha256'); let bytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
  await pipeline(response.body, meter, createWriteStream(join(root, `${path}.partial`), { flags: 'wx' }));
  await rename(join(root, `${path}.partial`), join(root, path));
  files.push({ path, role, bytes, sha256: hash.digest('hex') });
}
const downloads = await Promise.allSettled(Array.from({ length: 4 }, async () => {
  while (cursor < names.length) {
    const name = names[cursor++];
    await download(`https://huggingface.co/mlc-ai/${model}-MLC/resolve/${revision}/${name}`,
      `models/qwen/resolve/main/${name}`, name.endsWith('.bin') ? 'weights' : name.startsWith('tokenizer') ? 'tokenizer' : 'config');
    if (files.length % 10 === 0) console.log(`prepared ${files.length}/${names.length} assets`);
  }
}));
for (const result of downloads) if (result.status === 'rejected') throw result.reason;
await download(`https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/${runtimeRevision}/web-llm-models/v0_2_84/base/${model}_cs1k-webgpu.wasm`, 'runtime/qwen.wasm', 'runtime');
files.sort((a, b) => a.path.localeCompare(b.path));
const bytes = Buffer.from(JSON.stringify({ version: 1, id: `qwen-${size}-test`, engine: 'webllm', engineVersion: '0.2.85', files }, null, 2));
await writeFile(join(root, 'manifest.json'), bytes);
await writeFile(join(root, 'fixture-approval.json'), JSON.stringify({ manifestHash: createHash('sha256').update(bytes).digest('hex'), revision, runtimeRevision }));
await build({ entryPoints: ['src/inference/webllm.mjs'], outfile: join(root, 'summarizer.mjs'), external: ['url', 'module'], bundle: true, platform: 'browser', format: 'esm' });
console.log(`Prepared ${files.reduce((n, f) => n + f.bytes, 0)} bytes. Approval is test-only, not production signing.`);
