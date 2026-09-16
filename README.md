# open-meeting-notes

회의 오디오를 로컬에서 녹음·전사하고 원문 근거가 연결된 요약 후보를 만드는 Electron 앱입니다. Microsoft Graph 및 회의 일정 연동은 현재 범위에 포함하지 않습니다.

## 현재 상태

개발 버전입니다. 입력 확인 → 명시적 녹음 시작 → 일시정지·재개 → 저장 → 로컬 전사·요약 → 원문 검토·수정 → Markdown 내보내기를 구현했습니다. 중단된 녹음은 검증된 구간을 별도 WAV로 복구할 수 있습니다.

최신 로컬 개발 산출물은 모델을 포함한 **R9**입니다. 합성 입력으로 패키지 녹음·복구 및 실제 로컬 모델의 한국어 전사·요약을 검증했습니다. 이는 실제 회의 전체 품질이나 장시간 안정성을 보증하지 않습니다.

**엄격한 외부 통신 금지 배포 요건은 아직 충족하지 않았습니다.** 앱의 로컬 추론·Chromium 요청 제한과 OS 전체 송신 차단은 별개이며, OS 차단·코드 서명·대상 Windows 10/macOS 장비 검증이 남아 있습니다. 

## 개발 실행

Node.js 24 이상과 npm이 필요합니다. 개발 의존성 설치는 인터넷 또는 사내 패키지 미러를 사용합니다. 이는 설치 후 앱의 로컬 모델 실행과 구분됩니다.

```sh
npm ci
npm run build:inference
npm start
```

실제 입력 취득에는 OS의 마이크·화면 공유 권한이 필요합니다. 모델이 없으면 녹음은 가능하지만 전사·요약 기능은 사용할 수 없습니다. 승인된 로컬 모델팩 설정을 `models/installed.json`에 제공합니다. 이 설정과 모델 가중치는 Git에서 제외됩니다.

모델 설정 형식은 다음과 같습니다. 필요한 모델만 지정할 수 있으며 해시는 신뢰된 설치 절차에서 제공해야 합니다.

```json
{
  "version": 1,
  "stt": {
    "root": "packs/stt",
    "modelId": "whisper-small",
    "approvedManifestHash": "<64자리 SHA-256>"
  },
  "summary": {
    "root": "packs/summary",
    "approvedManifestHash": "<64자리 SHA-256>"
  },
  "vad": {
    "root": "packs/vad",
    "approvedManifestHash": "<64자리 SHA-256>"
  }
}
```

앱에서 상대 경로는 `models/` 기준입니다. 절대 로컬 경로도 지원하며 URL·UNC·경로 이탈 및 링크를 통한 우회는 거절합니다. STT는 Transformers.js/Whisper, 요약은 WebLLM, 발화 감지는 Silero를 사용합니다. 승인된 manifest와 모든 모델 파일의 무결성을 검사하며 누락 파일을 외부에서 자동 다운로드하지 않습니다.

## 테스트

```sh
npm test
npm run test:app
npm run test:electron
npm run test:preflight
npm run test:recording-crash
npm run test:pause-race
npm run test:capture-soak
npm run test:package-config
```

Electron 시험은 실행 가능한 데스크톱 환경이 필요합니다. `test:capture-soak`는 기본 60초의 실제 시간 합성 입력 시험이며 `OMN_CAPTURE_SOAK_MS`로 기간을 지정합니다. `test:recording-volume`은 가속된 2시간 PCM 용량 시험이므로 실제 2시간 장치 녹음 시험과 다릅니다.

실제 모델 시험은 별도로 반입한 승인 모델팩과 fixture 환경변수가 필요합니다. 기본 테스트에 모델 가중치나 실제 회의 데이터를 포함하지 않습니다. 실행 명령 전체는 [package.json](package.json)을 참조하세요.

## Windows 개발 패키징

Windows x64에서 설치된 Electron 런타임과 빌드된 추론 번들을 사용합니다.

```sh
npm run package:windows -- OUTPUT_DIRECTORY TRUSTED_INSTALLATION_JSON
npm run package:windows -- OUTPUT_DIRECTORY TRUSTED_INSTALLATION_JSON --bundle-models
npm run verify:package -- PACKAGE_DIRECTORY APPROVED_MANIFEST_SHA256
npm run audit:windows-egress -- PACKAGE_DIRECTORY APPROVED_MANIFEST_SHA256
```

`--bundle-models`는 승인 manifest에 열거된 모델 자산만 포함하고 상대 경로 설정을 만듭니다. 기존 출력 폴더는 덮어쓰지 않습니다. 모델 배포 권한·라이선스 고지와 사내 승인은 별도로 확인해야 합니다. 감사 명령은 OS 정책을 변경하지 않으며 구성 확인만으로 실제 송신 차단이 입증되지는 않습니다.

## 저장소 범위

소스, 테스트, 빌드 스크립트와 의존성 잠금 파일을 관리합니다. 개발 설계·상세 검증 기록은 `docs/private/`에서 로컬로만 관리하며, 모델·녹음·생성 결과·배포 실행 파일과 함께 `.gitignore`로 제외합니다. 비공개 문서를 `git add -f`로 강제 추가하지 마세요.
