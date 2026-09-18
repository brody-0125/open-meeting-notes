import { resolve } from 'node:path';
import { verifyDevelopmentPackage } from '../src/package-integrity.mjs';
const [root, approvedManifestHash] = process.argv.slice(2);
if (!root || !approvedManifestHash) throw new Error('usage: node scripts/verify-package.mjs PACKAGE_DIRECTORY APPROVED_MANIFEST_SHA256');
const manifest = await verifyDevelopmentPackage({ root: resolve(root), approvedManifestHash });
console.log(JSON.stringify({ verified: true, signed: false, files: manifest.files.length, appVersion: manifest.appVersion }));
