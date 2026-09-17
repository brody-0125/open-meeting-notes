import { release } from 'node:os';
import { mapAnalysisLanguageToLocale, assertAnalysisLanguageMatchesSttLocale } from '../stt-settings.mjs';

function macOSMajor() {
  const major = Number.parseInt(release().split('.')[0], 10);
  return Number.isFinite(major) ? major : 0;
}

export async function ensureAppleSttReady(stt, language, probe) {
  assertAnalysisLanguageMatchesSttLocale(stt, language);
  if (process.platform !== 'darwin') throw new Error('apple speech recognition requires macOS');
  if (macOSMajor() < 26) throw new Error('apple speech recognition requires macOS 26 or later');
  const locale = mapAnalysisLanguageToLocale(language);
  const result = await probe(locale);
  if (!result?.ok || !result.available || !result.installed) throw new Error('apple speech locale unavailable');
}

export function sttDisplayLabel(stt) {
  if (stt.backend === 'apple') return `macOS 음성 인식 (${stt.locale})`;
  return `로컬 Whisper (${stt.modelId})`;
}
