# Maintainer tools

`tools/` contains reusable developer utilities. Product code stays in `src/`, assertions and scenario-specific UI flows stay in `test/`, and build/package/installation commands stay in `scripts/`. These tools are not included in the desktop app package.

Run `npm run compile` once after changing `.mts` sources. Generated `.mjs` files are ignored. No new dependencies are needed. Executable tools accept explicit input/output paths, can run from another working directory, and do not run merely because their modules are imported.

## Summary judge

```sh
npm run tools:judge-summary -- --input evaluation.json --output test-results/judge
```

After compilation, an absolute path to `tools/summary-judge.mjs` works from any directory. `--help` describes options. Input is JSON:

```json
{
  "sourceText": "추가 예산은 승인하지 않았습니다.",
  "criteria": { "budget": "추가 예산 미승인" },
  "candidates": ["추가 예산은 미승인 상태입니다."]
}
```

- Requires an installed, signed-in Codex CLI. This tool sends the supplied text to a hosted model; it is separate from the offline application. Use synthetic evaluation data for regression tests.
- `--model`, `--bin`, `--timeout-ms` override the model, executable/JS entry and inference timeout. Defaults retain the existing `gpt-5.5`, `OMN_JUDGE_MODEL`/`OMN_JUDGE_BIN` overrides and 180-second timeout. On Windows, use the CLI's `codex.js` entry rather than a `.cmd` shim; the default checks the usual per-user npm installation location.
- Each run creates a unique `judge-*` subdirectory with prompt, schema, raw response, events, stderr and validated report. Previous runs are preserved. There are no automatic retries or model substitutions.
- Exit status: `0` all candidates pass, `1` at least one semantic failure, `2` invalid input or execution/response failure. Successful evaluation emits the report as JSON on stdout. `directory` identifies its artifacts.
- Invalid quotations, omitted candidates and tool-use events fail closed. Criteria/candidates can change without editing the runner. Calibrated positive/negative controls remain the caller's responsibility; a standalone invocation does not establish judge accuracy or independence from the model under test.
- Library: `judgeSummaries(criteria, candidates, output, sourceText, { model, binary, timeoutMs })`; `validateVerdict` is also exported. Existing fake-mic regression uses this same implementation.

## Speech corpus generation (Windows SAPI)

```powershell
.\tools\audio\prepare-speech.ps1 -CorpusPath test/fixtures/meeting-summary.json -OutputDirectory test-results/speech
```

Input is an array of `{ id, text, voiceRate?, leadSilenceMs?, tailSilenceMs? }`. IDs must be unique lowercase alphanumeric/hyphen names starting with a letter. Rate is an integer from -10 to 10; silence durations are integers from 0 to 10000 ms. Missing values are zero.

`-VoiceName` selects an installed SAPI voice (default: Microsoft Heami Desktop). The tool validates every case before writing, escapes text as literal speech, and emits 16 kHz mono PCM16 WAV plus `.wav.sha256` sidecars. Existing output requires `-Force`. Voice installation and corpus approval are explicit maintainer steps. Review WAV/hash changes before replacing pinned fixtures; do not regenerate fixtures during model evaluation. Mid-generation failures may leave partial output; choose a new directory or explicitly rerun with `-Force`.

## Inference double

Import `installInferenceDouble` from `tools/testing/inference-double.mjs`. Browser tests define `globalThis.inferenceHandlers` and pass the function to `page.evaluate`; callers in another JS realm can instead pass `{ handlers, workerUrl, errorCodes }` explicitly. Defaults match the app's module Worker and bounded error codes.

Only registered operations execute. The double copies messages, responds asynchronously, records `inferenceDouble.requests`/`unexpected`, and drops late replies after termination. `inferenceDouble.restore()` terminates its workers and restores the original Worker constructor. Reinstalling without restoring is rejected. It has no Electron, Playwright, filesystem, network or model dependency.

It replaces computation, not the application's client/IPC/storage validation. Use native Worker and real-model tests for runtime/model behavior. Keep scenario handlers next to their test; do not grow a universal fake model.

## Retention and verification

- Keep recurring tools only when they have a caller, documented inputs/outputs and a meaningful check. Add options for actual reuse needs, not speculative plugin systems.
- One-off diagnostic code belongs in an OS temporary directory and is deleted after use. Preserve useful failure reports separately; they are evidence, not reusable code.
- Outputs belong in ignored `test-results/`, another explicit output directory, or OS temp. Do not promote machine-specific paths, browser profiles or generated reports into tools.
- `npm test` checks the judge CLI with a local process double (no hosted calls), inference-double lifecycle and the Windows SAPI generator (requires Microsoft Zira Desktop on Windows; skipped on other OSes). Existing Electron suites verify their production integration. The hosted fake-mic/LLM-judge run remains opt-in.

During this cleanup, the temporary fake-microphone `probe.mjs` / `inspect.cjs` and `omn-summary-status.cjs` diagnostics were removed. Old helper locations and their generated JS were removed; imports and corpus-generation commands now reference `tools/`. Existing capture evidence and pinned WAV fixtures were preserved.
