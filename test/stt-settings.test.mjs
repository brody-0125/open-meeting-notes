import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAnalysisLanguageToLocale, sttSettingsHash, assertAnalysisLanguageMatchesSttLocale } from '../src/stt-settings.mjs';

test('maps analysis language to Apple locale', () => {
  assert.equal(mapAnalysisLanguageToLocale('ko'), 'ko-KR');
  assert.equal(mapAnalysisLanguageToLocale('en'), 'en-US');
});

test('settings hash encodes backend separately', () => {
  const vad = 'a'.repeat(64);
  const transformers = sttSettingsHash({ stt: { backend: 'transformers', device: 'wasm' }, language: 'ko', vadModelHash: vad });
  const apple = sttSettingsHash({ stt: { backend: 'apple', locale: 'ko-KR', preset: 'offlineTranscription' }, language: 'ko', vadModelHash: vad });
  assert.notEqual(transformers, apple);
});

test('apple locale must match analysis language', () => {
  assert.throws(() => assertAnalysisLanguageMatchesSttLocale({ backend: 'apple', locale: 'ko-KR' }, 'en'), /locale/);
  assertAnalysisLanguageMatchesSttLocale({ backend: 'apple', locale: 'en-US' }, 'en');
});
