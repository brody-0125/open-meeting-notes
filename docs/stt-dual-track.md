# STT dual-track

Two transcription backends share one downstream pipeline (VAD review, jobs, summary, export).

## Decided

| ID | Decision |
|----|----------|
| D1 | **Fallback `none`** — Apple STT unavailable → no automatic Whisper fallback. |
| D2 | Analysis UI **`ko` / `en`**; Apple locale **`ko-KR` / `en-US`** via fixed mapping; `installed.json` `stt.locale` is deployment approval; mismatch → reject analysis. |
| D3 | **Renderer → Main** Float32 PCM IPC; **Main → helper** stdio JSON header line + raw float32 LE body. |
| D4 | One codebase. OS bundles and `models/installed.json` profiles differ. |

## Tracks

- **Track A (`transformers`)** — Approved Whisper pack, renderer `InferenceClient` + worker.
- **Track B (`apple`)** — macOS 26+ `omn-speech-helper`, Main `AppleSttBridge`; no Whisper ONNX routes.

## `installed.json`

**Transformers (default)**

```json
{
  "version": 1,
  "stt": {
    "backend": "transformers",
    "root": "packs/stt",
    "modelId": "whisper-small",
    "approvedManifestHash": "<64 hex>",
    "device": "webgpu"
  }
}
```

`backend` omitted ⇒ `transformers`.

**Apple**

```json
{
  "version": 1,
  "stt": {
    "backend": "apple",
    "locale": "ko-KR",
    "preset": "offlineTranscription",
    "approvedCapabilityHash": "<64 hex>"
  }
}
```

Capability bytes live at `models/apple-stt-capability.json` (hashed at install verification).

## Helper framing (D3)

Request: one JSON line, then `bytes` of float32 LE samples.

```json
{"op":"transcribe","id":1,"locale":"ko-KR","preset":"offlineTranscription","sampleRate":16000,"bytes":64000}
```

Response: one JSON line.

```json
{"id":1,"ok":true,"chunks":[{"text":"…","start":0.1,"end":0.5}]}
```

Probe: `{"op":"probe","locale":"ko-KR"}` → `{"ok":true,"available":true,"installed":true}`.

Tests use `scripts/apple-stt-mock-helper.mjs` via `OMN_APPLE_STT_HELPER`.

Production helper sources: `native/macos/omn-speech-helper/` (SwiftPM, `SpeechEngine.swift`). Build with `npm run build:apple-stt-helper` on macOS 26 + Xcode 26. Packaged apps load `Contents/Resources/helpers/omn-speech-helper`.

Locale model install during transcribe uses Apple `AssetInventory` (may use system network once). This does not change D1 (no Whisper fallback).

## Examples

Copy and fill hashes from your trusted install procedure:

- [`examples/apple-stt-capability.json`](examples/apple-stt-capability.json)
- [`examples/installed-apple.json`](examples/installed-apple.json)

`sha256sum docs/examples/apple-stt-capability.json` → `stt.approvedCapabilityHash`.

## Manual verification (macOS 26 hardware)

| Step | Command / action | Pass criteria |
|------|------------------|---------------|
| Build helper | `npm run build:apple-stt-helper -- --release` | Binary exists under `.build/release/` |
| Probe | `npm run verify:apple-stt-helper` | JSON `ok: true`; `installed: true` after locale model install |
| Package | `npm run package:macos -- … installed.json --bundle-models` | Helper in `Resources/helpers/`; plist speech usage string |
| App analysis | Apple `installed.json`, language `ko` | Transcript segments; no Whisper worker load |

## CI

| Workflow | Runner | Checks |
|----------|--------|--------|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) `test` | `ubuntu-latest` | `npm test`, `test:package-config` (Windows packaging), `test:stt` (Whisper tiny + pinned `test/fixtures/speech.wav`) |
| same `macos-apple-stt` | `macos-15` | `npm run ci:macos-apple-stt` — Swift release build, helper probe/transcribe framing, macOS deployment tests |
| [`.github/workflows/macos-apple-stt-strict.yml`](../.github/workflows/macos-apple-stt-strict.yml) | `macos-26` (when available) | `OMN_APPLE_STT_STRICT=1` — `SpeechTranscriber` must report `available` |

Local mac check: `npm run ci:macos-apple-stt`. Strict probe: `OMN_APPLE_STT_STRICT=1 npm run verify:apple-stt-helper`.

## Job identity

`settingsHash` version **2** includes `backend` and engine fields so Whisper and Apple jobs never mix.
