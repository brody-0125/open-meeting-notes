// Maintainer P0 smoke: Track A Whisper integration tests with local fixtures only.
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureRoot = resolve(process.argv[2] ?? join(homedir(), '.cache', 'omn-stt-smoke-fixtures'));
const stt = join(fixtureRoot, 'stt');
const summary = join(fixtureRoot, 'summary');

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function usage() {
  const sttDir = join(fixtureRoot, 'stt');
  const summaryDir = join(fixtureRoot, 'summary');
  console.log(`Local P0 Whisper smoke (Track A transformers).

One-time fixture prep (downloads models; not run during tests):

  mkdir "${fixtureRoot}"
  node scripts/prepare-stt-test.mjs "${sttDir}" whisper-tiny
  node scripts/prepare-summary-test.mjs "${summaryDir}" 4b

Pinned speech.wav is copied into the STT fixture by prepare-stt-test.
Windows-only regeneration (Microsoft Zira): scripts/prepare-speech-test.ps1

Run smoke:
  node scripts/run-local-stt-smoke.mjs "${fixtureRoot}"

Manual env:
  OMN_STT_FIXTURE=${sttDir}
  OMN_SUMMARY_FIXTURE=${summaryDir}

P0+ before release: npm run test:app-models && npm run test:korean-small-flow
`);
}

async function requireFixtures() {
  for (const [label, dir, files] of [
    ['STT', stt, ['fixture-approval.json', 'speech.wav']],
    ['summary', summary, ['fixture-approval.json']]
  ] as const) {
    for (const file of files) {
      if (!(await exists(join(dir, file)))) {
        console.error(`Missing ${label} fixture: ${join(dir, file)}`);
        usage();
        process.exit(1);
      }
    }
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command === 'npm' ? npm : command, args, { cwd: repoRoot, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await requireFixtures();
const env = { ...process.env, OMN_STT_FIXTURE: stt, OMN_SUMMARY_FIXTURE: summary };
console.log(`OMN_STT_FIXTURE=${stt}`);
console.log(`OMN_SUMMARY_FIXTURE=${summary}`);
run('npm', ['run', 'build:inference'], env);
for (const script of ['test:stt', 'test:worker', 'test:pipeline']) run('npm', ['run', script], env);
