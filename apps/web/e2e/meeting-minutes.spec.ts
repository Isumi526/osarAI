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
