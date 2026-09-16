// Reproducible lexical baseline, not a semantic or release-quality verdict.
export function normalizeTranscript(text) {
  if (typeof text !== 'string') throw new Error('text required');
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
export function characterErrors(reference, hypothesis) {
  const a = [...normalizeTranscript(reference)], b = [...normalizeTranscript(hypothesis)];
  if (!a.length) throw new Error('nonempty normalized reference required');
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return { edits: previous[b.length], referenceCharacters: a.length, cer: previous[b.length] / a.length };
}
export function literalChecks(hypothesis, checks) {
  const text = normalizeTranscript(hypothesis);
  return checks.map(check => ({ label: check.label, present: check.anyOf.some(term => {
    const normalized = normalizeTranscript(term); return normalized.length > 0 && text.includes(normalized);
  }) }));
}
