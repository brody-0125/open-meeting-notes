// Offline development packaging from the already installed Electron runtime.
// This is not Authenticode signing or an installer.
import { mkdir, cp, rename, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDevelopmentPackage } from '../src/package-integrity.mjs';
import { installedModels, installationRoot } from '../src/electron/installed-models.mjs';
import { readVerifiedModelAsset } from '../src/model-pack.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('requires installed Windows x64 Electron');
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const target = resolve(process.argv[2] ?? join(root, '..', 'releases', `open-meeting-notes-win32-x64-${pkg.version}`));
// Trusted deployment input supplied separately from model packs. Verify before
// creating output; include the exact configuration in the package inventory.
const modelConfig = process.argv[3] ? JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')) : undefined;
const bundleModels = process.argv[4] === '--bundle-models';
if (process.argv.length > 5 && !bundleModels || process.argv.length > 6 || bundleModels && !modelConfig) throw new Error('invalid packaging arguments');
let installed;
if (modelConfig !== undefined) {
  const baseDirectory = dirname(resolve(process.argv[3]));
  installed = await installedModels(modelConfig, { baseDirectory });
  // This development packager references external packs; preserve the original
  // config file's base rather than accidentally rebasing them into the output.
  for (const kind of ['stt', 'summary', 'vad']) if (modelConfig[kind])
    modelConfig[kind].root = installationRoot(modelConfig[kind].root, baseDirectory);
}
for (const name of ['whisper', 'summarizer', 'silero']) await stat(join(root, 'dist', `${name}.js`));
await mkdir(resolve(target, '..'), { recursive: true });
await mkdir(target); // Refuse existing output; never overwrite an earlier build.
await cp(join(root, 'node_modules/electron/dist'), target, { recursive: true,
  filter: source => basename(source) !== 'default_app.asar' });
await rename(join(target, 'electron.exe'), join(target, 'open-meeting-notes.exe'));
const app = join(target, 'resources/app'); await mkdir(app, { recursive: true });
if (modelConfig !== undefined) {
  await mkdir(join(app, 'models'));
  if (bundleModels) for (const [kind, pack] of installed.packs) {
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
    modelConfig[kind].root = `packs/${kind}`;
  }
  await installedModels(modelConfig, { baseDirectory: join(app, 'models') });
  await writeFile(join(app, 'models/installed.json'), JSON.stringify(modelConfig, null, 2));
}
await cp(join(root, 'src'), join(app, 'src'), { recursive: true, filter: source => !/\.(mts|cts)$/.test(source) });
await cp(join(root, 'dist'), join(app, 'dist'), { recursive: true });
await writeFile(join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', main: 'src/electron/main.mjs' }, null, 2));
// Retain installed dependency license/notice files, including transitive bundles.
async function licenses(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await licenses(path);
    else if (/^(license|licence|notice)([.-]|$)/i.test(entry.name)) {
      const destination = join(target, 'dependency-notices', relative(join(root, 'node_modules'), path));
      await mkdir(resolve(destination, '..'), { recursive: true }); await cp(path, destination);
    }
  }
}
await licenses(join(root, 'node_modules'));
await writeFile(join(target, 'READ-ME.txt'), 'open-meeting-notes — unsigned development build\nRun open-meeting-notes.exe. No Node/npm installation is required.\n' +
  (bundleModels ? 'Approved-manifest model assets are included under resources/app/models/packs. This verifies integrity, not organizational or license approval. No meeting data is included.\n' : 'No model or meeting data is included. Model installation metadata belongs in resources/app/models/installed.json and must point to approved local packs.\n') +
  'Offline model inference does not enforce process-wide network isolation. OS-level egress containment is not verified; this package does not yet meet the strict no-external-communication deployment requirement.\nDo not treat this development package as a signed production release.\n');
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
  platform: 'win32-x64', signed: false, files }, null, 2);
await writeFile(join(target, 'build-manifest.json'), manifest);
const manifestHash = createHash('sha256').update(manifest).digest('hex');
await verifyDevelopmentPackage({ root: target, approvedManifestHash: manifestHash });
console.log(JSON.stringify({ target, manifestHash, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) }));
