// Offline development packaging from the installed Electron runtime (macOS).
import { mkdir, cp, rename, readFile, writeFile, readdir, stat, access, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedModels, installationRoot } from '../src/electron/installed-models.mjs';
import { readVerifiedModelAsset } from '../src/model-pack.mjs';

if (process.platform !== 'darwin') throw new Error('requires macOS host');

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const target = resolve(process.argv[2] ?? join(root, '..', 'releases', `open-meeting-notes-darwin-${process.arch}-${pkg.version}`));
const modelConfigPath = process.argv[3] ? resolve(process.argv[3]) : undefined;
const modelConfig = modelConfigPath ? JSON.parse(await readFile(modelConfigPath, 'utf8')) : undefined;
const bundleModels = process.argv[4] === '--bundle-models';
if (process.argv.length > 5 && !bundleModels || process.argv.length > 6 || bundleModels && !modelConfig) throw new Error('invalid packaging arguments');

let installed;
const baseDirectory = modelConfigPath ? dirname(modelConfigPath) : undefined;
if (modelConfig !== undefined) {
  installed = await installedModels(modelConfig, { baseDirectory });
  for (const kind of ['stt', 'summary', 'vad']) {
    const record = modelConfig[kind];
    if (!record?.root) continue;
    record.root = installationRoot(record.root, baseDirectory);
  }
}

const inferenceBundles = ['summarizer', 'silero'];
if (!modelConfig?.stt || modelConfig.stt.backend !== 'apple') inferenceBundles.unshift('whisper');
for (const name of inferenceBundles) await stat(join(root, 'dist', `${name}.js`));

const helperCandidates = [
  join(root, 'native/macos/omn-speech-helper/.build/release/omn-speech-helper'),
  join(root, 'native/macos/omn-speech-helper/.build/debug/omn-speech-helper')
];
let helperPath;
for (const candidate of helperCandidates) {
  try { await access(candidate); helperPath = candidate; break; } catch { /* next */ }
}
if (modelConfig?.stt?.backend === 'apple' && !helperPath) throw new Error('apple STT packaging requires built omn-speech-helper (npm run build:apple-stt-helper)');

await mkdir(resolve(target, '..'), { recursive: true });
await mkdir(target);
await cp(join(root, 'node_modules/electron/dist/Electron.app'), join(target, 'open-meeting-notes.app'), { recursive: true,
  filter: source => !source.endsWith('default_app.asar') });
const resources = join(target, 'open-meeting-notes.app/Contents/Resources');
const app = join(resources, 'app');
await mkdir(app, { recursive: true });

if (modelConfig !== undefined) {
  await mkdir(join(app, 'models'));
  if (bundleModels) {
    for (const [kind, pack] of installed.packs) {
      const destination = join(app, 'models/packs', kind);
      await mkdir(destination, { recursive: true });
      const manifest = await readFile(join(pack.root, 'manifest.json'));
      if (createHash('sha256').update(manifest).digest('hex') !== pack.manifestHash) throw new Error('manifest changed during packaging');
      await writeFile(join(destination, 'manifest.json'), manifest, { flag: 'wx' });
      for (const file of pack.files) {
        const targetFile = join(destination, file.path);
        await mkdir(dirname(targetFile), { recursive: true });
        await writeFile(targetFile, await readVerifiedModelAsset(pack, file), { flag: 'wx' });
      }
      if (modelConfig[kind]?.root) modelConfig[kind].root = `packs/${kind}`;
    }
    if (modelConfig.stt?.backend === 'apple') {
      await cp(join(baseDirectory, 'apple-stt-capability.json'), join(app, 'models/apple-stt-capability.json'));
      modelConfig.stt = { ...modelConfig.stt };
    }
  }
  const packagedBase = join(app, 'models');
  await installedModels(modelConfig, { baseDirectory: packagedBase });
  await writeFile(join(packagedBase, 'installed.json'), JSON.stringify(modelConfig, null, 2));
}

if (helperPath) {
  const helpers = join(resources, 'helpers');
  await mkdir(helpers, { recursive: true });
  const destination = join(helpers, 'omn-speech-helper');
  await cp(helperPath, destination);
  await chmod(destination, 0o755);
}

const infoPlist = join(target, 'open-meeting-notes.app/Contents/Info.plist');
await mergePrivacyPlist(infoPlist);

await cp(join(root, 'src'), join(app, 'src'), { recursive: true });
await cp(join(root, 'dist'), join(app, 'dist'), { recursive: true });
await writeFile(join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', main: 'src/electron/main.mjs' }, null, 2));

await writeFile(join(target, 'READ-ME.txt'), 'open-meeting-notes — unsigned development build (macOS)\n' +
  (bundleModels ? 'Approved model assets under open-meeting-notes.app/Contents/Resources/app/models/.\n' : 'No bundled models.\n') +
  (helperPath ? 'Apple STT helper is in Contents/Resources/helpers/omn-speech-helper.\n' : ''));

const files = [];
async function inventory(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else if (entry.isFile()) {
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
      files.push({ path: relative(target, path).replaceAll('\\', '/'), bytes, sha256: hash.digest('hex') });
    } else throw new Error('unexpected package link');
  }
}
await inventory(target);
const manifest = JSON.stringify({ version: 1, appVersion: pkg.version, electronVersion: pkg.devDependencies.electron,
  platform: `darwin-${process.arch}`, signed: false, files }, null, 2);
await writeFile(join(target, 'build-manifest.json'), manifest);
console.log(JSON.stringify({ target, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), helper: Boolean(helperPath) }));

async function mergePrivacyPlist(plistPath) {
  const buddy = '/usr/libexec/PlistBuddy';
  const entries = [
    ['NSSpeechRecognitionUsageDescription', '회의 전사를 위해 이 기기의 음성 인식을 사용합니다.'],
    ['NSMicrophoneUsageDescription', '회의 오디오를 녹음하려면 마이크 접근이 필요합니다.']
  ];
  for (const [key, value] of entries) {
    const add = spawnSync(buddy, ['-c', `Add :${key} string ${value}`, plistPath], { encoding: 'utf8' });
    if (add.status !== 0) spawnSync(buddy, ['-c', `Set :${key} ${value}`, plistPath], { encoding: 'utf8' });
  }
}
