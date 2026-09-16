import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meetingMarkdown, saveMeetingMarkdown } from '../src/export.mjs';
const result = () => ({ transcript: { revision: 1, segments: [{ id: 's1', evidenceIds: ['s1', 'duplicate'], source: 'microphone', start: 0, end: 1, rawText: '보고서를 보냅니다.' }] },
  summary: { version: 1, revision: 1, items: [{ kind: 'action', text: '보고서 보내기', status: 'candidate', evidence: [{ segmentId: 'duplicate', quote: '보고서를 보냅니다.' }] }] } });

test('unconfirmed speech exports as review material and rejects attached summary claims', () => {
  const r = result(); r.transcript.segments[0].flags = ['speech-unconfirmed'];
  assert.throws(() => meetingMarkdown('session', r), /unconfirmed speech/);
  r.summary = null; r.needsReview = true;
  const markdown = meetingMarkdown('session', r);
  assert.match(markdown, /상태: 발화 미확인/);
  assert.match(markdown, /보고서를 보냅니다/);
});

test('user speech decisions are explicit in exports and excluded text cannot be quoted as summary evidence', () => {
  const r = result(); r.transcript.segments[0].flags = ['speech-unconfirmed'];
  r.transcript.segments[0].speechReview = 'accepted';
  assert.match(meetingMarkdown('session', r), /사용자가 요약 근거로 사용/);
  r.transcript.segments[0].speechReview = 'rejected';
  assert.throws(() => meetingMarkdown('session', r), /evidence/);
  r.summary = null;
  assert.match(meetingMarkdown('session', r), /사용자가 요약 근거에서 제외/);
  assert.match(meetingMarkdown('session', r), /상태: 사용자 판단으로 요약 근거 모두 제외/);
});

test('evidence IDs stay unique across excluded and included text regardless of order', () => {
  for (const decisions of [['rejected', 'accepted'], ['accepted', 'rejected'], ['rejected', 'rejected']]) {
    const r = result(); r.summary = null;
    const original = r.transcript.segments[0];
    r.transcript.segments = decisions.map((speechReview, i) => ({ ...original, id: `s${i + 1}`,
      evidenceIds: [`s${i + 1}`, 'shared'], flags: ['speech-unconfirmed'], speechReview }));
    assert.throws(() => meetingMarkdown('session', r), /invalid export evidence ID/, decisions.join(','));
  }
  const r = result(); r.summary = null;
  Object.assign(r.transcript.segments[0], { evidenceIds: ['s1', 's1'], flags: ['speech-unconfirmed'], speechReview: 'rejected' });
  assert.throws(() => meetingMarkdown('session', r), /invalid export evidence ID/);
});

test('ambiguous excluded evidence cannot create an export file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-export-ambiguous-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const r = result(), segment = r.transcript.segments[0];
  r.transcript.segments.unshift({ ...segment, id: 'excluded', flags: ['speech-unconfirmed'], speechReview: 'rejected' });
  await assert.rejects(saveMeetingMarkdown(root, 'session', r), /invalid export evidence ID/);
  assert.deepEqual(await readdir(root), []);
});

test('reconciled export uses final items and judgments instead of old per-part claims', () => {
  const r = result(), part = structuredClone(r.summary);
  part.items[0].text = '이전 구간 후보';
  r.summaryParts = { state: 'complete', total: 2, parts: [{ index: 0, summary: part }, { index: 1, summary: part }] };
  r.reconciliation = { state: 'complete' }; r.reviews = [['accepted']];
  const text = meetingMarkdown('session', r);
  assert.match(text, /통합 요약 완료/);
  assert.match(text, /사용자 채택/);
  assert.doesNotMatch(text, /이전 구간 후보|통합되지 않았/);
  r.reconciliation.state = 'failed'; r.summary = null; delete r.reviews; r.summaryError = 'context budget';
  assert.match(meetingMarkdown('session', r), /요약 미완료/);
  assert.match(meetingMarkdown('session', r), /이전 구간 후보/);
});
test('Markdown preserves original text, evidence aliases and candidate status without active markup', () => {
  const r = result();
  r.transcript.segments[0].rawText += '\n```\n<img src="https://external/image">';
  const markdown = meetingMarkdown('session', r);
  assert.match(markdown, /검토 전 후보/);
  assert.match(markdown, /duplicate/);
  assert.ok(markdown.includes('````text\n' + r.transcript.segments[0].rawText + '\n````'));
  assert.match(markdown, /0\.000–1\.000초/);
  r.summary.items[0].evidence[0].quote = 'invented';
  assert.throws(() => meetingMarkdown('session', r), /evidence/);
});
test('partial and conflicted results are explicitly incomplete, and invalid completion counts fail', () => {
  const r = result();
  r.summaryParts = { state: 'partial', total: 2, parts: [{ index: 0, summary: r.summary }] };
  r.summary = null; r.summaryError = 'GPU lost';
  assert.match(meetingMarkdown('session', r), /부분 완료: 1\/2/);
  r.summaryParts.state = 'complete';
  assert.throws(() => meetingMarkdown('session', r), /completion/);
  delete r.summaryParts; r.needsReview = true;
  assert.match(meetingMarkdown('session', r), /전사 충돌·누락 검토 필요/);
  assert.throws(() => meetingMarkdown('../escape', r), /session/);
});
test('exports create distinct complete local files without modifying earlier exports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omn-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await saveMeetingMarkdown(root, 'session', result());
  const second = await saveMeetingMarkdown(root, 'session', result());
  assert.notEqual(first.path, second.path);
  assert.equal(await readFile(first.path, 'utf8'), meetingMarkdown('session', result()));
  assert.equal((await readdir(root)).filter(n => n.endsWith('.md')).length, 2);
  assert.ok((await readdir(root)).every(n => !n.endsWith('.partial')));
});

test('export includes separate user judgments and retains rejected candidates as an audit record', () => {
  const r = result(); r.reviews = [['accepted']];
  assert.match(meetingMarkdown('session', r), /사용자 채택/);
  assert.equal(r.summary.items[0].status, 'candidate');
  r.reviews[0][0] = 'rejected';
  assert.match(meetingMarkdown('session', r), /사용자 제외/);
  assert.match(meetingMarkdown('session', r), /보고서 보내기/);
  r.reviews[0][0] = 'confirmed';
  assert.throws(() => meetingMarkdown('session', r), /reviews/);
});

test('corrected export distinguishes user text from the preserved model transcript', () => {
  const r = result(); r.transcript.segments[0].originalRawText = '원래 모델의 문장';
  const markdown = meetingMarkdown('session', r);
  assert.match(markdown, /사용자 수정 전사:/);
  assert.match(markdown, /보존된 모델 전사 원본:/);
  assert.match(markdown, /원래 모델의 문장/);
});
