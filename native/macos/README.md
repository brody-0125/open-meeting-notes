# macOS native STT helper

`omn-speech-helper` implements the stdio protocol in `docs/stt-dual-track.md`.

## Build (macOS + Swift 6)

```sh
npm run build:apple-stt-helper
# release binary:
npm run build:apple-stt-helper -- --release
```

Output: `native/macos/omn-speech-helper/.build/{debug,release}/omn-speech-helper`

## Development override

```sh
export OMN_APPLE_STT_HELPER="node scripts/apple-stt-mock-helper.mjs"
```

## Packaging

```sh
npm run build:inference
npm run build:apple-stt-helper -- --release
node scripts/package-macos.mjs ../releases/my-mac-build ./models/installed-apple.json --bundle-models
```

Apple `installed.json` must sit beside `apple-stt-capability.json` under `models/`.

`SpeechEngine.live.swift` uses `SpeechAnalyzer` + `SpeechTranscriber` (macOS 26 SDK). `build-apple-stt-helper.mjs` copies it to `SpeechEngine.swift` on macOS 26+; macOS 15 CI builds the committed stub. The host app must declare `NSSpeechRecognitionUsageDescription`.

`AssetInventory.downloadAndInstall()` runs during transcribe when the locale model is missing (system-managed download). Analysis policy remains `fallback: none` at the app level (no Whisper fallback).

Verify on device:

```sh
npm run build:apple-stt-helper -- --release
echo '{"op":"probe","locale":"ko-KR"}' | .build/release/omn-speech-helper
```
