import { test, expect } from '@playwright/test';
import { LEGAL, hasPlaceholder, legalReady, PLACEHOLDER } from '../lib/legal';

// 法務ページの下書きガード（2026-09-28）。穴埋め（【要記入】）が残っている間は、本番では
// 改定版の利用規約・プライバシーポリシー・特商法表記を公開しない。埋め終わったらこのテストの
// 1本目を「legalReady() が true」に書き換える（公開した状態を固定する）。
test('穴埋めの検出: 【要記入 を含む文字列だけを下書きとみなす', () => {
  expect(hasPlaceholder('運営者: 山田商店')).toBe(false);
  expect(hasPlaceholder(`${PLACEHOLDER}: 住所】`)).toBe(true);
  expect(hasPlaceholder('確定済み', `${PLACEHOLDER}: 電話】`)).toBe(true);
});

test('現状は穴埋めが残っている（本番では下書きを公開しない）', () => {
  expect(legalReady()).toBe(false);
  expect(Object.values(LEGAL).some((v) => v.includes(PLACEHOLDER))).toBe(true);
});
