# Releasing

Release process for maintainers. Assumes `main` is green on [CI](.github/workflows/ci.yml).

## Version source of truth

- Application version: [`package.json`](package.json) `version`
- User-facing history: [`CHANGELOG.md`](CHANGELOG.md)
- License: [`LICENSE.md`](LICENSE.md) (MIT, Seokhyeon Kim)

Update example metadata when bumping (e.g. [`docs/examples/apple-stt-capability.json`](docs/examples/apple-stt-capability.json) `appVersion`).

## 1.0.0 checklist

- [ ] `CHANGELOG.md` — move items from `[Unreleased]` if any; set release date on `[1.0.0]`
- [ ] `package.json` / `package-lock.json` — `1.0.0`
- [ ] `npm ci` && `npm run build:inference` && `npm test`
- [ ] macOS: `npm run ci:macos-apple-stt` (on a Mac runner or machine)
- [ ] Build and smoke-test packages on target OS (models supplied locally; not in Git)
- [ ] **P0 local Whisper smoke** (Track A): `npm run smoke:stt-local` after one-time fixture prep (see [docs/stt-dual-track.md](docs/stt-dual-track.md))
- [ ] **P0+ before release:** `npm run test:app-models` and `npm run test:korean-small-flow` with `whisper-small` / Korean speech fixtures
- [ ] Git tag `v1.0.0` on the release commit
- [ ] GitHub Release with notes from `CHANGELOG.md` `[1.0.0]`
- [ ] Attach unsigned development packages (not stored in Git):
  - **Windows x64:** `npm run package:windows -- releases/open-meeting-notes-<version>-win32-x64` then zip and `gh release upload`.
  - **macOS:** `npm run package:macos -- releases/...` (see README), or use [`.github/workflows/release-artifacts.yml`](.github/workflows/release-artifacts.yml) (`workflow_dispatch` with tag, or automatic on `release: published`).

## Tag and GitHub release (example)

```sh
git checkout main
git pull origin main
# after version/changelog commit:
git tag -a v1.0.0 -m "open-meeting-notes 1.0.0"
git push origin main
git push origin v1.0.0
gh release create v1.0.0 --title "1.0.0" --notes-file CHANGELOG_SNIPPET.md
```

Pass the `[1.0.0]` section from the changelog as `--notes` or `--notes-file`.

## Korean synthetic STT regression (P1)

Optional **regression thermometer** on the fixed six-sentence corpus in [`test/fixtures/korean-stt.json`](test/fixtures/korean-stt.json). It is not a release pass/fail gate and does not replace P0+ app flows (`test:korean-small-flow`).

**Baseline (committed):** [`reports/baseline/korean-whisper-tiny.json`](reports/baseline/korean-whisper-tiny.json) — `corpusSha256`, per-case `audioSha256`, CER, and literal checks from `whisper-tiny` q8/WASM.

**Regenerate speech (Windows, one-time per machine):** Microsoft **Heami Desktop** via SAPI.

```powershell
$Fixture = Join-Path $PWD '.omn-stt-fixture'
$Speech = Join-Path $PWD '.omn-korean-speech'
node scripts/prepare-stt-test.mjs $Fixture whisper-tiny
.\tools\audio\prepare-speech.ps1 -OutputDirectory $Speech -CorpusPath test/fixtures/korean-stt.json
```

**Evaluate and compare:**

```powershell
$env:OMN_STT_FIXTURE = $Fixture
npm run evaluate:korean-stt -- $Speech reports/korean-whisper-tiny.json whisper-tiny
npm run compare:korean-stt -- reports/baseline/korean-whisper-tiny.json reports/korean-whisper-tiny.json
```

Use `whisper-small` the same way when the team runs a release or monthly check; there is no committed small baseline yet.

**PRs and release notes:** After STT-related changes, run the compare command and note **microCer delta** and any **new literal misses** in the PR description or GitHub release notes. The repo does not enforce a CER threshold in CI.

**Corpus changes:** Edit only `test/fixtures/korean-stt.json` and regenerate `.wav` with `tools/audio/prepare-speech.ps1`. Keep stable `id`, reference `text`, `checks`, and recorded `audioSha256` in the baseline report; refresh the committed baseline when the corpus or voice changes.

## Fake microphone to summary semantic regression

Run `npm run test:fake-mic-summary` on a desktop with WebGPU. This is an opt-in integration test, separate from the fast `npm test` suite. It defaults to the approved local `models/packs/stt` (Whisper small), `models/packs/summary` (Qwen3 4B), and `models/packs/vad` packs. Override them with `OMN_STT_FIXTURE`, `OMN_SUMMARY_FIXTURE`, and `OMN_VAD_FIXTURE`; preparation uses the existing `prepare-*-test` scripts. The app downloads no models and stays offline. The separate judge requires a logged-in Codex CLI and network access; only the synthetic source text, criteria, controls, captured transcript, and generated summary are sent to it.

The fixed scenario is [beta launch planning](test/fixtures/meeting-summary.json): November 11 beta launch, two owners/tasks/deadlines, an unapproved 5 million won budget deferred to the next meeting, and an undecided public launch. Ground truth is authored before generation, not derived from the model output being evaluated. The pinned [WAV](test/fixtures/beta-launch.wav) is Microsoft Heami Desktop speech at SAPI rate 4 with 8 seconds of leading and 2 seconds of trailing silence (about 26 seconds total). This baseline fits one 30-second transcription window. A first, slower 40-second version exposed overlapping transcription at a window boundary and correctly stopped before automatic summary; this short case does not cover that longer-recording path or bypass its review gate.

The test launches Electron with `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture=<absolute WAV path>%noloop`. It retains native `getUserMedia`, production microphone processing, permission gating, AudioWorklet/IPC storage, and the UI's real STT/summary workers. Only the native confirmation dialog and shared-audio source are simulated; shared audio is silent. The preflight must finish before speech starts. This does not test physical devices or OS loopback.

After recording, the test clicks **전사·요약**, checks durable audio and completed analysis, and evaluates only summary text (never its source blockquotes). A separate Codex CLI invocation (default model `gpt-5.5`, override with `OMN_JUDGE_MODEL`) judges each fact as supported/missing/contradicted and quotes its evidence. All five criteria must be supported in both the transcript and summary, with no claims unsupported by the original script. Rubric v2 records unambiguous minor spelling/spacing errors as warnings; it never excuses changes to people, tasks, dates, amounts, or negation. Before accepting the real verdict, the judge must pass a paraphrased reference, reject a control with swapped owners/approved budget/invented public date, reject a missing-launch-date control, accept recoverable spelling errors with explicit warnings, and reject a genuinely changed task. Malformed, incomplete, or ungrounded responses fail the test. Candidates have anonymous IDs and are evaluated together without pass/fail labels. Shell tools, apps, multi-agent tools, and web search are disabled; the CLI runs read-only in a separate artifact directory, ignores user configuration, and does not persist a chat session. A local Qwen judge was rejected during development because it accepted a missing date and fabricated an evidence quote. LLM verdicts remain a calibrated regression signal, not a quality guarantee.

The printed evidence directory contains the recording, `transcript.txt`, `summary.txt`, `summary.png`, and `report.json` with hashes, model/runtime versions, controls, per-fact verdicts, quality warnings, and failures. `failureStage` distinguishes analysis, transcription, and summary failures after judge calibration. The unique `judge-*` subdirectory preserves the exact prompt, JSON schema, CLI events and verdict; its path is returned as `judge.directory`. Artifacts are retained on failure; local model browser caches can be large. Set `OMN_FAKE_MIC_REPORT_DIR` to choose the parent directory. A new run directory prevents reuse of prior analysis results. Failures are not retried or converted to skips.

Use a current Codex CLI supporting `--ignore-user-config`, `--ephemeral` and `--output-schema`. On Windows the default uses the standard global npm `codex.js` entry under `%APPDATA%/npm`; set `OMN_JUDGE_BIN` to the native executable or `codex.js` entry for another installation. Other platforms use `codex` on PATH. Authentication/model access errors fail rather than skip the test. The structured judge follows the [official OpenAI evaluation pattern](https://developers.openai.com/blog/eval-skills).

Regenerate intentionally on Windows when the scenario/voice changes, then review the reference and new audio together:

```powershell
.\tools\audio\prepare-speech.ps1 -OutputDirectory test/fixtures -CorpusPath test/fixtures/meeting-summary.json -Force
npm run test:fake-mic-summary
```

## Review follow-up from the fake-microphone run (2026-10-05)

| Finding | Change / acceptance criterion | Status |
| --- | --- | --- |
| Recoverable STT spelling was scored as a different task | Rubric v2 separates semantic failures from quoted quality warnings; paired typo/changed-task controls must pass/fail respectively. Raw audio/transcript remain unchanged. | Implemented |
| A summary omitted a launch date present in its evidence | Prompt requires concrete facts in summary text; missing-date control remains a hard failure. Judge scores transcript and summary separately. | Implemented; model quality remains measured, not guaranteed |
| Long job IDs consume input/output tokens and vary between recordings | Model sees stable `s0`, `s1`, … aliases; validated evidence is restored to original IDs. Tests cover alias collisions, invented evidence and identical requests after renaming job IDs. Prompt/cache version bumped to v5. | Implemented |
| Incomplete summary errors hid the stopping reason | Shared JSON response parser maps `length` to `OUTPUT_LIMIT`; partition/Main/UI preserve it. Cached transcripts and valid completed parts survive; truncated summaries are never accepted. | Implemented |
| Capture stop timer included variable device acquisition time | Wait from the observed recording state; assert that saved capture fits the single-window baseline. | Implemented |
| A slower 40-second recording hit overlapping transcript boundaries | Add a dedicated boundary corpus covering repeated words, partial words and negation. Any future alignment must retain original audio/timestamps/evidence and still block ambiguous contradictions. Do not auto-merge by text similarity alone. | P1 follow-up; review gate retained |
| One synthetic voice and a single meeting cannot establish accuracy | Add normal-rate/multi-speaker/noisy Korean cases, then measure semantic pass rate and warnings across repeated runs. Independently test physical devices/OS loopback. | P1 follow-up |

Run `npm test` for evidence mapping, error propagation, cache integrity, and judge-output validation, then `npm run test:fake-mic-summary` for actual capture/model/evaluator behavior. Retain failed reports; do not change expected facts to match generated output or silently retry until a pass.

Validation on 2026-10-05: 330 unit tests passed; the focused Electron output-limit status test passed; one fresh fake-microphone E2E run passed with the unchanged pinned WAV. All five calibration controls behaved as expected, and transcript/summary each preserved all five required facts with no warnings on that run. This is a single-run check, not a measured long-run accuracy or stability rate.

## Integration doubles and duplicate coverage (2026-10-05)

Reusable utilities now live under [`tools/`](tools/README.md): the standalone summary judge, Windows speech corpus generator, and inference double. Test scenarios remain in `test/`; generated evidence stays outside versioned source.

`tools/testing/inference-double.mts` replaces model computation only. Requests must have an explicitly registered handler; unsupported operations fail. Requests/results are structured-cloned, responses cross an asynchronous task boundary, termination suppresses late completion, and bounded error codes use the production Worker response shape. Its contract is checked with the real `InferenceClient` in `test/inference-double.test.mts`. It does not establish native Worker scheduling, model quality, microphone permission, or OS-device correctness.

The output-limit integration in `analysis-ui.test.mts` now drives the product UI, inference client, IPC, validators, job store, export and retry. It first injects a wrong-source transcript and requires rejection without a committed job. A subsequent valid run fails the second summary part with `OUTPUT_LIMIT`; export preserves the first part, retry computes only the missing part and reconciliation, and a final repeat uses cached jobs. Speech-review and suspend-analysis tests share the strict double; preview IPC's narrower responder rejects any operation except transcription. Capture tests independently measure the expected 440/880 Hz input signatures and amplitude in persisted PCM, in addition to comparing sink bytes with storage. The real-model analysis UI test reads the versioned WAV directly instead of relying on an extra copy in the model installation; correction/review interactions explicitly select the transcript tab.

| Removed duplicate | Remaining owner / preserved check |
| --- | --- |
| Standalone Electron Worklet pause/resume happy path | `capture.test.mts` drives the same Worklet through capture, IPC and storage; transferred boundary/sequence continuity assertions. `worklet.test.mts` retains protocol, stale-resume and backpressure cases. |
| VAD-flavoured generic client busy/abort/late-reply case | Existing generic `inference-client.test.mts` lifecycle tests; VAD operation forwarding added to worker-reuse coverage. Actual VAD frame/model tests remain. |
| Directly injected partial/complete render fixtures inside the real-model analysis test, plus render-only output-limit test | One fault-injected product-flow integration owns partial progress, output-limit propagation, evidence export and cached retry. Dedicated reconciliation UI tests still cover reconciliation failure rendering. |

Keep unit, IPC, real-model and fake-microphone tests when they validate different boundaries. Similar scenario names alone are not grounds for removal. The native fake-WAV → STT → summary → calibrated LLM judge test remains separate and unchanged.

Run `npm test`, then the affected Electron suites with prepared, approved local model packs (the double-based cases verify installation but do not run those model weights):

```powershell
$env:OMN_STT_FIXTURE = (Resolve-Path models/packs/stt).Path
$env:OMN_SUMMARY_FIXTURE = (Resolve-Path models/packs/summary).Path
$env:OMN_VAD_FIXTURE = (Resolve-Path models/packs/vad).Path
node --test --test-concurrency=1 test/electron/capture.test.mjs test/electron/analysis-ui.test.mjs test/electron/speech-review.test.mjs test/electron/suspend-analysis.test.mjs test/electron/transcript-audio.test.mjs
```

Validation: `npm test` passed all 330 tests. The affected Electron suites passed 11 cases together; the real-model UI case initially exposed the missing model-folder WAV copy, then passed in a focused rerun after switching to the pinned repository WAV (about 116 seconds). All 12 affected Electron cases are therefore verified, including actual STT/summary, review/correction, cancellation and cached retry. The fake-microphone/LLM-judge E2E was preserved and was not rerun for this test-only change.

## Post-release

- Open `[Unreleased]` in `CHANGELOG.md` for the next cycle.
- Bump `package.json` on `main` when the next development line starts.
