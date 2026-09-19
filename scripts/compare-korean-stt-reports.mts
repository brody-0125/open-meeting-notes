import { readFile } from 'node:fs/promises';

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) throw new Error('usage: compare-korean-stt-reports.mjs baseline.json candidate.json');

type LiteralCheck = { label: string; present: boolean };
type Case = { id: string; cer: number; literalChecks: LiteralCheck[] };
type Report = { model: string; corpusSha256: string; microCer: number; cases: Case[] };

const load = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Report;
const baseline = await load(baselinePath);
const candidate = await load(candidatePath);

if (baseline.corpusSha256 !== candidate.corpusSha256)
  console.warn(`corpusSha256 mismatch: baseline ${baseline.corpusSha256} candidate ${candidate.corpusSha256}`);
if (baseline.model !== candidate.model) throw new Error(`model mismatch: ${baseline.model} vs ${candidate.model}`);

const misses = (checks: LiteralCheck[]) => checks.filter(c => !c.present).map(c => c.label);
const byId = new Map(baseline.cases.map(c => [c.id, c]));
const deltaPp = (candidate.microCer - baseline.microCer) * 100;
console.log(`microCer baseline ${(baseline.microCer * 100).toFixed(2)}% candidate ${(candidate.microCer * 100).toFixed(2)}% delta ${deltaPp >= 0 ? '+' : ''}${deltaPp.toFixed(2)} pp`);

for (const c of candidate.cases) {
  const b = byId.get(c.id);
  if (!b) { console.log(`${c.id}: new case (no baseline row)`); continue; }
  const cerDeltaPp = (c.cer - b.cer) * 100;
  const newMisses = misses(c.literalChecks).filter(label => !misses(b.literalChecks).includes(label));
  if (cerDeltaPp === 0 && !newMisses.length) continue;
  const parts = [];
  if (cerDeltaPp) parts.push(`CER ${cerDeltaPp >= 0 ? '+' : ''}${cerDeltaPp.toFixed(1)} pp`);
  if (newMisses.length) parts.push(`new literal misses: ${newMisses.join(', ')}`);
  console.log(`${c.id}: ${parts.join('; ')}`);
}
