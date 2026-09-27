import { test, expect } from '@playwright/test';
import { pruneEmptyMinutesSections } from '@osarai/shared';

// 議事録に「- 特になし」だけの見出しが残ると、次回会う前に読み返す時のノイズになる（人レビュー 2026-09-22）。

const minutes = [
  '【会議の概要】',
  '- 初回の情報交換',
  '',
  '【相手の事業・プロフィール】',
  '- 都内でジムを2店舗運営',
  '',
  '【自分が約束したこと】',
  '- 特になし',
  '',
  '【次回の予定】',
  '- なし',
  '',
  '【決定事項・その他】',
  '- 次回は10月に再調整',
].join('\n');

test('pruneEmptyMinutesSections: 中身が「特になし」だけの見出しは丸ごと落とす', () => {
  const out = pruneEmptyMinutesSections(minutes);
  expect(out).toContain('【会議の概要】');
  expect(out).toContain('【相手の事業・プロフィール】');
  expect(out).toContain('【決定事項・その他】');
  expect(out).not.toContain('【自分が約束したこと】');
  expect(out).not.toContain('【次回の予定】');
  expect(out).not.toContain('特になし');
});

test('pruneEmptyMinutesSections: 中身のある見出しと本文は保つ', () => {
  const out = pruneEmptyMinutesSections(minutes);
  expect(out).toContain('- 都内でジムを2店舗運営');
  expect(out.split('\n\n').length).toBe(3); // 残った3ブロック
});

test('pruneEmptyMinutesSections: 見出しの無い議事録はそのまま', () => {
  expect(pruneEmptyMinutesSections('ただのメモ\n2行目')).toBe('ただのメモ\n2行目');
});

import { dropSelfLabels } from '../lib/meeting-speakers';

// 本人が無言なのに議事録で「自分が話した」ことにされる問題（人レビュー 2026-09-22）。
// マイクゲートの取りこぼしで1行だけ「自分:」が付くので、決定的に相手へ寄せる。

test('dropSelfLabels: 紛れ込んだ「自分:」を直前の話者に寄せる', () => {
  const t = ['相手1: おもろいやろ。', '自分: なんかもうどっしり', '相手1: ほっこり。'].join('\n');
  expect(dropSelfLabels(t)).toBe(['相手1: おもろいやろ。', '相手1: なんかもうどっしり', '相手1: ほっこり。'].join('\n'));
});

test('dropSelfLabels: 先頭が「自分:」なら fallback に寄せる', () => {
  expect(dropSelfLabels('自分: あー', '相手1')).toBe('相手1: あー');
});

test('dropSelfLabels: 相手のラベルと本文はそのまま', () => {
  const t = '相手2: 自分の話をします。\n相手1: どうぞ。';
  expect(dropSelfLabels(t)).toBe(t);
});

import { parseTimedTranscript, mergeTimedTranscripts } from '../lib/meeting-speakers';

// 2トラック録音（2026-09-22）: 相手と自分を別ファイルで文字起こしし、時刻で1本に合成する。
// これで話者の取り違えが原理的に起きなくなる（Notta と同じ仕組み）。

test('parseTimedTranscript: [MM:SS] を秒に直し、行内のラベルがあれば優先する', () => {
  const lines = parseTimedTranscript('[00:03] はい、もしもし。\n[01:10] 相手2: 途中から失礼します。', '相手1');
  expect(lines).toEqual([
    { sec: 3, label: '相手1', text: 'はい、もしもし。' },
    { sec: 70, label: '相手2', text: '途中から失礼します。' },
  ]);
});

test('parseTimedTranscript: 時刻の無い行は直前の時刻に続けて拾う（落とさない）', () => {
  const lines = parseTimedTranscript('[00:05] あー\n続きの行', '自分');
  expect(lines.map((l) => l.sec)).toEqual([5, 5]);
  expect(lines[1]!.text).toBe('続きの行');
});

test('mergeTimedTranscripts: 時刻順に合成し、1行1発話のまま残す', () => {
  const other = parseTimedTranscript('[00:00] もしもし\n[00:08] どうした？', '相手1');
  const self = parseTimedTranscript('[00:04] すいません\n[00:05] 相談があって', '自分');
  expect(mergeTimedTranscripts(other, self)).toBe(
    ['相手1: もしもし', '自分: すいません', '自分: 相談があって', '相手1: どうした？'].join('\n'),
  );
});

test('mergeTimedTranscripts: 自分トラックが空なら相手だけの文字起こしになる', () => {
  const other = parseTimedTranscript('[00:00] おもろいやろ。\n[00:03] ほっこり。', '相手1');
  expect(mergeTimedTranscripts(other, [])).toBe('相手1: おもろいやろ。\n相手1: ほっこり。');
});

import { dropLeakedSelfLines } from '../lib/meeting-speakers';

// スピーカー再生時にマイクへ回り込んだ相手の声（イヤホン無し）。エコーキャンセルの取りこぼしを
// テキストで落とす。ゲートで音を削ると本人の声まで消えるため、この順にする（2026-09-22）。

test('dropLeakedSelfLines: 相手と同じ発話が近い時刻に自分側へ入っていたら落とす', () => {
  const other = parseTimedTranscript('[00:10] 来週の水曜日はいかがですか。', '相手1');
  const self = parseTimedTranscript('[00:11] 来週の水曜日はいかがですか\n[00:20] はい、大丈夫です。', '自分');
  const kept = dropLeakedSelfLines(self, other);
  expect(kept.map((l) => l.text)).toEqual(['はい、大丈夫です。']);
});

test('dropLeakedSelfLines: 時刻が離れていれば本人の発言として残す', () => {
  const other = parseTimedTranscript('[00:10] ありがとうございます。', '相手1');
  const self = parseTimedTranscript('[05:00] ありがとうございます。', '自分');
  expect(dropLeakedSelfLines(self, other)).toHaveLength(1);
});

test('dropLeakedSelfLines: 相手トラックが空なら何も落とさない', () => {
  const self = parseTimedTranscript('[00:03] はい。', '自分');
  expect(dropLeakedSelfLines(self, [])).toHaveLength(1);
});
