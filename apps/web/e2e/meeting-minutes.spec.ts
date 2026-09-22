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
