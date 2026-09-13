import { test, expect } from '@playwright/test';
import { parseSpeakers, relabelSpeakers, isSpeakerLabel } from '../lib/meeting-speakers';

// 会議録音T4/T7: 話者ラベルの純関数。ingest(parseSpeakers)・commit(relabelSpeakers)・
// toProposals(isSpeakerLabel) が共有する。Gemini を呼ばない決定的な回帰テスト。

const transcript = [
  '自分: 本日はありがとうございます。',
  '相手1: こちらこそ。相手1と申します。',
  '相手2: 途中から失礼します。',
  '自分: 相手1さんのご事業について伺えますか。',
  '相手1: はい、個人で事業をしています。',
].join('\n');

test('parseSpeakers: 行頭ラベルからロスターを作り「自分」だけ isSelf', () => {
  const speakers = parseSpeakers(transcript);
  expect(speakers).toEqual([
    { label: '自分', isSelf: true },
    { label: '相手1', isSelf: false },
    { label: '相手2', isSelf: false },
  ]);
});

test('parseSpeakers: ラベルの無い文字起こしは空', () => {
  expect(parseSpeakers('ラベルの無いただの文章です。\n二行目。')).toEqual([]);
});

test('relabelSpeakers: 行頭ラベルだけ実名化し、本文中の同語は触らない・二重スペースを残さない', () => {
  const out = relabelSpeakers(transcript, { 相手1: '山田', 相手2: '' , 自分: '自分' });
  const lines = out.split('\n');
  expect(lines[1]).toBe('山田: こちらこそ。相手1と申します。'); // 本文の「相手1」は保持
  expect(lines[3]).toBe('自分: 相手1さんのご事業について伺えますか。');
  expect(lines[4]).toBe('山田: はい、個人で事業をしています。');
  expect(lines[2]).toBe('相手2: 途中から失礼します。'); // 空名はスキップ
  expect(out).not.toMatch(/:  /); // コロン後の二重スペース無し（2c6e3a7 の回帰）
});

test('relabelSpeakers: 全角コロンと前後の空白も吸収する', () => {
  expect(relabelSpeakers('相手1：　はい', { 相手1: '佐藤' })).toBe('佐藤: はい');
});

test('isSpeakerLabel: ラベルそのものは人物名として扱わない', () => {
  for (const s of ['相手1', '相手 2', '話者A', '話者B', '自分', '相手', '話者']) expect(isSpeakerLabel(s)).toBe(true);
  for (const s of ['山田', '相手方株式会社', '話者太郎', '']) expect(isSpeakerLabel(s)).toBe(false);
});
