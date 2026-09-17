# open-meeting-notes

**Version 1.0.0** — Offline meeting capture, local transcription, and evidence-linked notes (Electron).

회의 오디오를 로컬에서 녹음·전사하고, 원문 근거가 연결된 요약 후보를 검토한 뒤 Markdown으로 보냅니다. Microsoft Graph·회의 일정 연동은 포함하지 않습니다.

| | |
|---|---|
| **License** | [MIT](LICENSE.md) — Copyright (c) 2026 Seokhyeon Kim |
| **Changelog** | [CHANGELOG.md](CHANGELOG.md) |
| **Node.js** | ≥ 24 (see `engines` in [package.json](package.json)) |
| **Platforms** | Windows x64, macOS (development packaging supported) |

## Features

- **Capture** — Input preflight, explicit record start, pause/resume, sealed storage.
- **STT** — Local Whisper (Transformers.js) by default; optional **Apple on-device speech** on macOS 26+ deployments ([dual-track](docs/stt-dual-track.md)).
- **VAD & review** — Silero-based speech boundaries; transcript review and corrections before export.
- **Summary** — Local WebLLM summarization with reconciliation and evidence links.
- **Recovery** — Interrupted recordings can export verified WAV segments.
- **Trusted models** — `models/installed.json` + approved manifest hashes; the app does not fetch missing weights from the internet.

## Quick start (development)

```sh
git clone https://github.com/brody-0125/open-meeting-notes.git
cd open-meeting-notes
npm ci
npm run build:inference
npm start
```

`npm ci` uses the network for npm packages only. Runtime inference uses models you install locally.

1. Grant OS microphone / screen-capture permissions when prompted.
2. Place approved model packs on disk and add [`models/installed.json`](docs/stt-dual-track.md) (not committed; see `.gitignore`).
3. Recording works without models; transcription and summary require configured packs.

### Minimal `installed.json` (Whisper / transformers)

Paths are relative to `models/` unless absolute (validated; no URL/UNC escape).

```json
{
  "version": 1,
  "stt": {
    "backend": "transformers",
    "root": "packs/stt",
    "modelId": "whisper-small",
    "approvedManifestHash": "<64-char SHA-256>"
  },
  "summary": {
    "root": "packs/summary",
    "approvedManifestHash": "<64-char SHA-256>"
  },
  "vad": {
    "root": "packs/vad",
    "approvedManifestHash": "<64-char SHA-256>"
  }
}
```

Apple STT profile examples: [`docs/examples/installed-apple.json`](docs/examples/installed-apple.json), [`docs/examples/apple-stt-capability.json`](docs/examples/apple-stt-capability.json).

## Documentation

| Topic | Location |
|--------|----------|
| STT backends (Whisper vs Apple), IPC, CI | [`docs/stt-dual-track.md`](docs/stt-dual-track.md) |
| macOS native helper | [`native/macos/README.md`](native/macos/README.md) |
| Release checklist | [`RELEASING.md`](RELEASING.md) |
| Private design notes (local only) | `docs/private/` (gitignored) |

## Testing

```sh
npm test
npm run test:package-config
```

On **macOS** (matches CI `macos-apple-stt` job):

```sh
npm run ci:macos-apple-stt
```

Electron integration tests (`test:app`, `test:electron`, model flows, soak tests) need a desktop environment and, for model tests, locally supplied packs. Full script list: [package.json](package.json).

## Packaging (development builds)

Not installers or store signing — offline folders built from the installed Electron runtime plus bundled app code.

**Windows x64**

```sh
npm run package:windows -- OUTPUT_DIR path/to/installed.json
npm run package:windows -- OUTPUT_DIR path/to/installed.json --bundle-models
npm run verify:package -- PACKAGE_DIR APPROVED_MANIFEST_SHA256
npm run audit:windows-egress -- PACKAGE_DIR APPROVED_MANIFEST_SHA256
```

**macOS (Apple STT profile)**

```sh
npm run build:apple-stt-helper -- --release
npm run verify:apple-stt-helper
npm run package:macos -- OUTPUT_DIR path/to/installed.json --bundle-models
```

`--bundle-models` copies only manifest-listed assets. Existing output directories are not overwritten. Model licenses and organizational approval are your responsibility.

## Limitations (1.0.0)

- **Development-grade deployment** — Validated on synthetic and local model fixtures (including Korean STT/summary smoke paths). Not a warranty for every meeting room, duration, or hardware.
- **Egress** — In-app local inference and Chromium restrictions are **not** the same as OS-wide block, Authenticode, or enterprise firewall policy. See README history in [CHANGELOG.md](CHANGELOG.md) and audit helpers for Windows packages.
- **Models** — Weights and recordings stay out of Git; compliance and retention are operator-owned.

## Repository layout

- `src/` — Application, Electron main/preload, UI, inference glue.
- `scripts/` — Build, package, verify, CI helpers.
- `test/` — Unit and integration tests (root `npm test` runs `test/*.test.mjs`).
- `native/macos/` — `omn-speech-helper` (Swift).

## Contributing

There is no separate contributor guide yet. Open an issue or pull request on GitHub. Do not commit `docs/private/`, model weights, recordings, or release binaries (`git add -f` on ignored paths is discouraged).

## License

Released under the [MIT License](LICENSE.md). Copyright (c) 2026 Seokhyeon Kim.
