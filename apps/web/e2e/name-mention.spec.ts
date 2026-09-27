import { test, expect } from '@playwright/test';
import { isNameMentioned } from '../lib/customer-context';

// 相談を1系統にまとめた（2026-09-27）: 発話に出た相手の議事録を読み込むため、名前の言及を拾う。
test('isNameMentioned: フルネーム・姓＋敬称を拾い、敬称なしの姓だけでは拾わない', () => {
  expect(isNameMentioned('村田涼太さんに次どう連絡しよう', '村田涼太')).toBe(true);
  expect(isNameMentioned('村田さんに次どう連絡しよう', '村田涼太')).toBe(true);
  expect(isNameMentioned('佐藤様との打ち合わせ', '佐藤 一郎')).toBe(true);
  expect(isNameMentioned('村田町の物件の件', '村田涼太')).toBe(false);
  expect(isNameMentioned('今日は誰とも会っていない', '村田涼太')).toBe(false);
});
