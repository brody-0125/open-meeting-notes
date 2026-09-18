import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function mapAnalysisLanguageToLocale(language) {
  if (language === 'ko') return 'ko-KR';
  if (language === 'en') return 'en-US';
  throw new Error('unsupported language');
}

export function sttSettingsHash({ stt, language, vadModelHash }) {
  const shared = {
    version: 2,
    language,
    preprocessing: 'web-audio-v4-segment-speech-review',
    vadModelHash: vadModelHash ?? null,
    vadThreshold: .5,
    windowSeconds: 30,
    overlapSeconds: 2
  };
  if (stt.backend === 'apple') {
    return sha({ ...shared, backend: 'apple', engine: 'apple-speech-transcriber',
      locale: stt.locale, preset: stt.preset ?? 'offlineTranscription' });
  }
  return sha({ ...shared, backend: 'transformers', engine: 'transformers-4.3.0', dtype: stt.dtype ?? 'q8',
    device: stt.device ?? 'wasm', maxTokens: 256 });
}

export function assertAnalysisLanguageMatchesSttLocale(stt, language) {
  if (stt?.backend !== 'apple') return;
  const locale = mapAnalysisLanguageToLocale(language);
  if (stt.locale !== locale) throw new Error('analysis language does not match installed speech locale');
}
