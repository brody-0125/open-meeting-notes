import { mkdir, lstat, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSummary } from './contracts.mjs';
import { reviewStates } from './reviews.mjs';
import { summaryGroups } from './summary-groups.mjs';
import { hasUnconfirmedSpeech, speechExcluded } from './transcript.mjs';

// All untrusted prose stays in a fence longer than any fence in the prose.
// Markdown/HTML from speech must not become active links, images or headings.
const literal = value => {
  if (typeof value !== 'string') throw new Error('invalid export text');
  let width = 3;
  for (const match of value.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
  const fence = '`'.repeat(width);
  return `${fence}text\n${value}\n${fence}\n`;
};
export function meetingMarkdown(sessionId, result) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(sessionId)) throw new Error('invalid export session');
  const transcript = result.transcript, evidence = [], evidenceIds = new Set();
  if (!Number.isSafeInteger(transcript?.revision) || transcript.revision < 0 || !Array.isArray(transcript.segments)) throw new Error('invalid export transcript');
  for (const s of transcript.segments) {
    if (!['microphone', 'remote'].includes(s.source) || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end < s.start || typeof s.rawText !== 'string') throw new Error('invalid export segment');
    const ids = s.evidenceIds ?? [s.id];
    if (!Array.isArray(ids) || !ids.length) throw new Error('missing export evidence IDs');
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/.test(id) || evidenceIds.has(id)) throw new Error('invalid export evidence ID');
      evidenceIds.add(id);
      if (!speechExcluded(s)) evidence.push({ id, text: s.rawText });
    }
  }
  const parts = result.summaryParts;
  if (parts && (!['complete', 'partial'].includes(parts.state) || !Number.isSafeInteger(parts.total) || parts.total < 1 ||
      !Array.isArray(parts.parts) || parts.parts.some((p, i) => p.index !== i) ||
      (parts.state === 'complete' ? parts.parts.length !== parts.total : parts.parts.length >= parts.total))) throw new Error('invalid export completion state');
  const reconciled = result.reconciliation?.state === 'complete';
  if (reconciled && (!result.summary || parts?.state !== 'complete')) throw new Error('invalid reconciliation completion');
  const groups = summaryGroups(result);
  if (hasUnconfirmedSpeech(transcript) && groups.length) throw new Error('unconfirmed speech cannot support summary export');
  if (result.reviews && (!Array.isArray(result.reviews) || result.reviews.length !== groups.length ||
      result.reviews.some((row, i) => !Array.isArray(row) || row.length !== groups[i].summary.items.length || row.some(s => !reviewStates.includes(s))))) throw new Error('invalid export reviews');
  for (const group of groups) validateSummary(group.summary, evidence, transcript.revision);
  const status = hasUnconfirmedSpeech(transcript) ? '발화 미확인: 원음 검토 필요' : result.needsReview ? '전사 충돌·누락 검토 필요' : parts?.state === 'partial' ? `부분 완료: ${parts.parts.length}/${parts.total}` :
    result.summaryError ? '요약 미완료' : reconciled ? '통합 요약 완료' : groups.length ? `구간 요약 완료: ${groups.length}/${parts?.total ?? 1}` :
    transcript.segments.length && transcript.segments.every(speechExcluded) ? '사용자 판단으로 요약 근거 모두 제외' : '요약 없음';
  const lines = ['# 회의 기록', '', `기록 ID: ${sessionId}`, `전사 revision: ${transcript.revision}`, '', `상태: ${status}`, '',
    '요약은 모델이 생성한 후보이며 사용자 판단은 항목별로 표시합니다. 인용의 일치는 의미적 정확성을 보장하지 않습니다.',
    reconciled ? '구간 간 통합 결과도 모델의 후보입니다. 결정 변경·취소를 전체 원문과 비교해 검토해야 합니다.' : '여러 구간의 결정 변경·취소는 통합되지 않았으므로 전체 원문을 검토해야 합니다.', ''];
  if (result.summaryError) lines.push('처리 오류:', literal(result.summaryError));
  if (transcript.pauses !== undefined) {
    if (!Array.isArray(transcript.pauses) || transcript.pauses.length > 20000) throw new Error('invalid export pauses');
    if (transcript.pauses.length) lines.push('## 사용자 일시정지', '', '다음 구간은 녹음하지 않았으며, 해당 구간의 발언은 전사·요약에 포함되지 않습니다.', '');
    for (const pause of transcript.pauses) {
      if (!pause || !Number.isSafeInteger(pause.pauseId) || pause.pauseId < 1 || !['microphone', 'remote'].includes(pause.source) ||
          !Number.isFinite(pause.start) || pause.start < 0 || pause.end !== null && (!Number.isFinite(pause.end) || pause.end < pause.start))
        throw new Error('invalid export pause');
      lines.push(`${pause.source === 'microphone' ? '마이크' : '공유 오디오'} · ${pause.start.toFixed(3)}${pause.end === null ? '초부터 재개 없이 녹음 종료' : `–${pause.end.toFixed(3)}초`}`, '');
    }
  }
  lines.push('## 요약 후보와 근거', '');
  for (const [groupIndex, group] of groups.entries()) {
    lines.push(reconciled ? '### 통합 후보' : `### 구간 ${group.index + 1}/${parts?.total ?? 1}`, '');
    for (const [itemIndex, item] of group.summary.items.entries()) {
      const state = result.reviews?.[groupIndex]?.[itemIndex] ?? 'candidate';
      const label = { candidate: '검토 전 후보', accepted: '사용자 채택', rejected: '사용자 제외' }[state];
      lines.push(`종류: ${{ action: '할 일', decision: '결정', topic: '논의' }[item.kind]} · ${label}`, literal(item.text));
      for (const e of item.evidence) lines.push(`근거 ID: ${e.segmentId}`, literal(e.quote));
    }
  }
  lines.push('## 전사 원문', '');
  for (const s of transcript.segments) {
    if (s.flags?.includes('speech-unconfirmed')) lines.push(s.speechReview === 'accepted'
      ? '발화 감지 미확인 · 사용자가 요약 근거로 사용하도록 판단했습니다.' : s.speechReview === 'rejected'
      ? '사용자가 요약 근거에서 제외했습니다. 원문은 보존합니다.' : '발화 미확인: 이 전사는 자동 요약 근거로 사용하지 않았습니다. 원음을 검토하세요.');
    lines.push(`### ${s.source === 'microphone' ? '마이크' : '공유 오디오'} · ${s.start.toFixed(3)}–${s.end.toFixed(3)}초`,
      `근거 ID: ${(s.evidenceIds ?? [s.id]).join(', ')}`, s.originalRawText === undefined ? '모델 전사:' : '사용자 수정 전사:', literal(s.rawText));
    if (s.originalRawText !== undefined) lines.push('보존된 모델 전사 원본:', literal(s.originalRawText));
  }
  return lines.join('\n');
}

// App-owned local export directory; renderer never supplies a path or content.
export async function saveMeetingMarkdown(directory, sessionId, result) {
  const content = meetingMarkdown(sessionId, result);
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe export directory');
  const path = join(directory, `${sessionId}-${randomUUID()}.md`), temporary = `${path}.partial`;
  const file = await open(temporary, 'wx');
  try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  if (process.platform !== 'win32') { const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  return { path };
}
