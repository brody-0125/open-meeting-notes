import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);

export async function verifyAppleSttCapability({ baseDirectory, record }) {
  if (!baseDirectory || typeof record.locale !== 'string' || !/^[a-z]{2}-[A-Z]{2}$/.test(record.locale)) throw new Error('invalid apple stt installation');
  const preset = record.preset ?? 'offlineTranscription';
  if (preset !== 'offlineTranscription') throw new Error('invalid apple stt installation');
  if (!validHash(record.approvedCapabilityHash)) throw new Error('approved capability hash required');
  const path = join(baseDirectory, 'apple-stt-capability.json');
  const bytes = await readFile(path);
  if (sha(bytes) !== record.approvedCapabilityHash) throw new Error('capability integrity mismatch');
  const capability = JSON.parse(bytes.toString('utf8'));
  if (capability.version !== 1 || capability.engine !== 'apple-speech-transcriber') throw new Error('invalid capability');
  if (!Array.isArray(capability.allowedLocales) || !capability.allowedLocales.includes(record.locale)) throw new Error('locale not approved');
  if (!Array.isArray(capability.allowedPresets) || !capability.allowedPresets.includes(preset)) throw new Error('preset not approved');
  return { locale: record.locale, preset, modelHash: record.approvedCapabilityHash };
}
