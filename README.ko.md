[English](README.md) | **한국어**

# open-meeting-notes

**버전 1.0.0** — 오프라인 회의 녹음, 로컬 전사, 근거가 연결된 노트 (Electron).

회의 오디오를 로컬에서 녹음·전사하고, 원문 근거가 연결된 요약 후보를 검토한 뒤 Markdown으로 보냅니다. Microsoft Graph·회의 일정 연동은 포함하지 않습니다.

| | |
|---|---|
| **라이선스** | [MIT](LICENSE.md) — Copyright (c) 2026 Seokhyeon Kim |
| **변경 기록** | [CHANGELOG.md](CHANGELOG.md) |
| **Node.js** | ≥ 24 ([package.json](package.json) `engines` 참고) |
| **플랫폼** | Windows x64, macOS (개발용 패키징 지원) |

## 기능

- **Capture** — 입력 사전점검, 명시적 녹음 시작, 일시정지/재개, 봉인 저장.
- **STT** — 기본은 로컬 Whisper (Transformers.js). macOS 26+ 배포에서는 **Apple 온디바이스 음성**을 선택할 수 있습니다 ([dual-track](docs/stt-dual-track.md)).
- **VAD & review** — Silero 기반 발화 경계. 보내기 전에 전사 검토·수정.
- **Summary** — 로컬 WebLLM 요약, 정합(reconciliation), 근거 링크.
- **Recovery** — 중단된 녹음에서 검증된 WAV 구간을 내보낼 수 있습니다.
- **Trusted models** — `models/installed.json`과 승인된 매니페스트 해시. 앱은 없는 가중치를 인터넷에서 받지 않습니다.

## 빠른 시작 (개발)

```sh
git clone https://github.com/brody-0125/open-meeting-notes.git
cd open-meeting-notes
npm ci
npm run build:inference
npm start
```

`npm start`, `npm test`, 패키징은 먼저 `tsc`를 돌립니다. 소스는 `.mts`/`.cts`이고 Electron은 예전과 같이 `.mjs`/`.cjs`를 로드합니다. `npm run compile`만 실행해도 그 파일을 만듭니다.

`npm ci`는 npm 패키지를 받을 때만 네트워크를 씁니다. 런타임 추론은 직접 설치한 모델을 사용합니다.

1. 요청이 뜨면 OS 마이크/화면 캡처 권한을 허용합니다.
2. 승인된 모델 팩을 디스크에 두고 [`models/installed.json`](docs/stt-dual-track.md)을 추가합니다 (커밋하지 않음. `.gitignore` 참고).
3. 녹음은 모델 없이 됩니다. 전사와 요약은 구성된 팩이 필요합니다.

### 최소 `installed.json` (Whisper / transformers)

경로는 절대 경로가 아니면 `models/` 기준입니다 (검증됨. URL/UNC로 빠져나가지 않음).

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

Apple STT 프로필 예: [`docs/examples/installed-apple.json`](docs/examples/installed-apple.json), [`docs/examples/apple-stt-capability.json`](docs/examples/apple-stt-capability.json).

## 문서

| 주제 | 위치 |
|--------|----------|
| STT 백엔드 (Whisper vs Apple), IPC, CI | [`docs/stt-dual-track.md`](docs/stt-dual-track.md) |
| macOS 네이티브 헬퍼 | [`native/macos/README.md`](native/macos/README.md) |
| 릴리스 체크리스트 | [`RELEASING.md`](RELEASING.md) |
| 한국어 합성 STT 회귀(P1) | [`RELEASING.md`](RELEASING.md#korean-synthetic-stt-regression-p1) |
| 비공개 설계 노트 (로컬 전용) | `docs/private/` (gitignore) |

## 테스트

```sh
npm test
npm run test:package-config
```

**macOS** (CI `macos-apple-stt` 작업과 동일):

```sh
npm run ci:macos-apple-stt
```

Electron 통합 테스트 (`test:app`, `test:electron`, 모델 플로, soak)는 데스크톱 환경이 필요하고, 모델 테스트는 로컬 팩이 필요합니다. 전체 스크립트: [package.json](package.json).

## 패키징 (개발 빌드)

설치된 Electron 런타임과 묶인 앱 코드로 오프라인 폴더를 만듭니다. 설치 프로그램이 아니고 스토어 서명을 하지 않습니다.

**Windows x64**

```sh
npm run package:windows -- OUTPUT_DIR path/to/installed.json
npm run package:windows -- OUTPUT_DIR path/to/installed.json --bundle-models
npm run verify:package -- PACKAGE_DIR APPROVED_MANIFEST_SHA256
npm run audit:windows-egress -- PACKAGE_DIR APPROVED_MANIFEST_SHA256
```

**macOS (Apple STT 프로필)**

```sh
npm run build:apple-stt-helper -- --release
npm run verify:apple-stt-helper
npm run package:macos -- OUTPUT_DIR path/to/installed.json --bundle-models
```

`--bundle-models`는 매니페스트에 적힌 자산만 복사합니다. 이미 있는 출력 디렉터리는 덮어쓰지 않습니다. 모델 라이선스와 조직 승인은 운영자 책임입니다.

## 제한 (1.0.0)

- **개발용 패키징** — 합성·로컬 모델 픽스처(한국어 STT/요약 스모크 포함)로 확인했습니다. 모든 회의실·길이·장비를 보장하지 않습니다.
- **Egress** — 앱 내부 로컬 추론과 Chromium 제한은 OS 전역 차단, Authenticode, 기업 방화벽과 같지 않습니다. [CHANGELOG.md](CHANGELOG.md)와 Windows 패키지 감사 헬퍼를 참고하세요.
- **모델** — 가중치와 녹음은 Git에 넣지 않습니다. 규정 준수와 보관은 운영자 책임입니다.

## 저장소 구조

- `src/` — 애플리케이션, Electron main/preload, UI, 추론 연결 (TypeScript. `tsc`가 `.mjs`/`.cjs`를 냄).
- `scripts/` — 빌드, 패키징, 검증, CI 헬퍼.
- `test/` — 단위·통합 테스트 (루트 `npm test`는 컴파일 후 `test/*.test.mjs`).
- `native/macos/` — `omn-speech-helper` (Swift).

## 기여

이슈나 pull request를 열어 주세요. `docs/private/`, 모델 가중치, 녹음, 릴리스 바이너리는 커밋하지 마세요. ignore된 경로에 `git add -f`를 쓰지 마세요.

## 라이선스

[MIT License](LICENSE.md)로 배포합니다. Copyright (c) 2026 Seokhyeon Kim.
