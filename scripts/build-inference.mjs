// Bundles installed dependencies only; does not fetch models or send data.
import { build } from 'esbuild';
await build({ entryPoints: { whisper: 'src/inference/whisper.mjs', summarizer: 'src/inference/webllm.mjs', silero: 'src/inference/silero.mjs' },
  // web-tokenizers contains Node-only branches; no Node polyfills enter the sandbox bundle.
  external: ['url', 'module'], outdir: 'dist', bundle: true, platform: 'browser', format: 'esm' });
