// Developer-only public model download. Application runtime never imports this.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
if (!process.argv[2]) throw new Error('fixture directory required');
const root = resolve(process.argv[2]);
const revision = '41f03a954b841327835dea1ddb7bb28ae23ddc2c';
const engineVersion = JSON.parse(await readFile('node_modules/onnxruntime-web/package.json', 'utf8')).version;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(join(root, 'models'), { recursive: true });
await mkdir(join(root, 'vad-runtime'), { recursive: true });
const response = await fetch(`https://raw.githubusercontent.com/snakers4/silero-vad/${revision}/src/silero_vad/data/silero_vad.onnx`);
if (!response.ok) throw new Error(`model download: ${response.status}`);
await writeFile(join(root, 'models/silero.onnx'), Buffer.from(await response.arrayBuffer()));
const paths = ['models/silero.onnx'];
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  const path = `vad-runtime/${name}`;
  await copyFile(join('node_modules/onnxruntime-web/dist', name), join(root, path));
  paths.push(path);
}
const files = await Promise.all(paths.map(async path => {
  const bytes = await readFile(join(root, path));
  return { path, role: path.endsWith('.onnx') ? 'weights' : 'runtime', bytes: bytes.length, sha256: hash(bytes) };
}));
const manifest = Buffer.from(JSON.stringify({ version: 1, id: 'silero-test', engine: 'silero', engineVersion, files }, null, 2));
await writeFile(join(root, 'manifest.json'), manifest);
await writeFile(join(root, 'fixture-approval.json'), JSON.stringify({ manifestHash: hash(manifest), revision }));
await build({ entryPoints: ['src/inference/silero.mjs'], outfile: join(root, 'silero.mjs'), bundle: true, platform: 'browser', format: 'esm' });
console.log('Prepared local VAD fixture; approval file is test-only, not a production trust anchor.');
