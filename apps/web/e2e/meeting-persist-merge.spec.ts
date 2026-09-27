import { test, expect } from '@playwright/test';
import { mergeNeeds, mergeArrayFields } from '../lib/assistant-persist';

// 会議録音T7: 既存つながりへの commit で needs / 配列型 custom_fields を「上書き」せず「追記」する。
// 1回の会議で相手の全ニーズが再抽出される保証はなく、前回までの蓄積（つながりたい人など）を消さない。

test('mergeNeeds: 既存に無いものだけ追記し、空なら既存を保つ', () => {
  expect(mergeNeeds('経営者と会いたい / 集客', ['集客', '同世代のフリーランス'])).toBe(
    '経営者と会いたい / 集客 / 同世代のフリーランス',
  );
  expect(mergeNeeds('経営者と会いたい', [])).toBe('経営者と会いたい');
  expect(mergeNeeds('経営者と会いたい', undefined)).toBe('経営者と会いたい');
  expect(mergeNeeds(null, ['集客'])).toBe('集客');
  expect(mergeNeeds(null, [])).toBeNull();
});

test('mergeNeeds: 表記揺れ（敬称・空白・全半角）は同一とみなす', () => {
  expect(mergeNeeds('集客', ['集　客', '集客'])).toBe('集客');
});

test('mergeArrayFields: 配列は和集合・それ以外は新しい値で上書き', () => {
  const merged = mergeArrayFields(
    { products: ['A商品'], wants_to_meet: ['経営者'], age: '30代' },
    { products: ['A商品', 'B商品'], wants_to_meet: ['30代のフリーランス'], age: '40代' },
  );
  expect(merged).toEqual({ products: ['A商品', 'B商品'], wants_to_meet: ['経営者', '30代のフリーランス'], age: '40代' });
});

test('mergeArrayFields: 既存に無いキーはそのまま入る', () => {
  expect(mergeArrayFields({}, { wants_to_meet: ['経営者'] })).toEqual({ wants_to_meet: ['経営者'] });
});
