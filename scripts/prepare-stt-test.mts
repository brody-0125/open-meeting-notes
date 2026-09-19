// Development-only fixture preparation, never imported by the application.
// Downloads public model artifacts; sends no audio or transcript.
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}
const root = resolve(process.argv[2] ?? (() => { throw new Error('fixture directory required'); })());
const modelId = process.argv[3] ?? 'whisper-tiny';
const revision = { 'whisper-tiny': 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7', 'whisper-small': '36050c46d777d46dc4b5f43f6d90574fc38f8732' }[modelId];
if (!revision) throw new Error('unsupported fixture model');
const modelFiles = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
const files = [];
for (const name of modelFiles) {
  const path = `models/${modelId}/${name}`;
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  const response = await fetch(`https://huggingface.co/onnx-community/${modelId}/resolve/${revision}/${name}`);
  if (!response.ok) throw new Error(`download ${name}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(target, bytes);
  files.push({ path, role: name.endsWith('.onnx') ? 'weights' : name.startsWith('tokenizer') ? 'tokenizer' : 'config', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`prepared ${name}: ${bytes.length} bytes`);
}
await mkdir(join(root, 'runtime'), { recursive: true });
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  const path = `runtime/${name}`;
  await copyFile(join('node_modules/onnxruntime-web/dist', name), join(root, path));
  const bytes = await readFile(join(root, path));
  files.push({ path, role: 'runtime', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const bytes = Buffer.from(JSON.stringify({ version: 1, id: `${modelId}-test`, engine: 'transformers', engineVersion: '4.3.0', files }, null, 2));
await writeFile(join(root, 'manifest.json'), bytes);
await writeFile(join(root, 'fixture-approval.json'), JSON.stringify({ manifestHash: createHash('sha256').update(bytes).digest('hex'), revision, modelId }));
const pinnedWav = fileURLToPath(new URL('../test/fixtures/speech.wav', import.meta.url));
const pinnedSha = (await readFile(fileURLToPath(new URL('../test/fixtures/speech.wav.sha256', import.meta.url)), 'utf8')).trim().toLowerCase();
const speech = await readFile(pinnedWav);
if (sha256(speech) !== pinnedSha) throw new Error('pinned speech.wav sha256 mismatch; update test/fixtures after regenerating with prepare-speech-test.ps1');
await copyFile(pinnedWav, join(root, 'speech.wav'));
await build({ entryPoints: ['src/inference/whisper.mjs'], outfile: join(root, 'whisper.mjs'), bundle: true, platform: 'browser', format: 'esm' });
console.log('Prepared test-only manifest approval; not a production trust/signing mechanism.');
