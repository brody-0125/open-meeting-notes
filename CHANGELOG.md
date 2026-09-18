# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Default README is English. Korean copy lives in [`README.ko.md`](README.ko.md).
- Application, tests, and Node scripts are TypeScript (`.mts`/`.cts`). `tsc` emits the same `.mjs`/`.cjs` runtime files as 1.0.0.

## [1.0.0] - 2026-09-17

First public release. Offline meeting capture, local transcription, evidence-linked summary review, and Markdown export.

### Added

- Electron desktop app: input preflight, explicit record start, pause/resume, save, local analysis, transcript review, corrections, and export.
- Trusted local model installation via `models/installed.json` with manifest hash verification; no automatic download of missing model weights from the network.
- Speech-to-text (default): Transformers.js / Whisper through an isolated inference worker (WASM or WebGPU).
- Speech-to-text (macOS 26+ profile): optional Apple on-device speech via `omn-speech-helper` and capability file; no Whisper fallback when Apple backend is selected ([`docs/stt-dual-track.md`](docs/stt-dual-track.md)).
- Voice activity detection (Silero), summarization (WebLLM), reconciliation and summary budgeting flows.
- Recovery of interrupted recordings to verified WAV segments; crash and storage-failure handling tests.
- Development packagers for Windows x64 and macOS; package integrity verification and Windows egress audit helper scripts.
- CI on Ubuntu (`npm test`, packaging config tests) and macOS 15 (`ci:macos-apple-stt`).

### Security and deployment notes

- Application-layer inference and Chromium egress limits are not equivalent to OS-wide egress blocking or code signing. Operators must validate deployment policy separately (see README).

[1.0.0]: https://github.com/brody-0125/open-meeting-notes/releases/tag/v1.0.0
