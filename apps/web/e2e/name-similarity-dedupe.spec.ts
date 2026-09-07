import { test, expect } from '@playwright/test';
import { findSimilarNames, nameSimilarity, canonicalName } from '@osarai/shared';

// 「人物名の表記揺れによるつながり重複登録を防ぐ」チケットの回帰。
// findSimilarNames()はpackages/shared/src/name-match.tsの純粋関数で、
// apps/web/lib/proposal-extraction.ts の toProposals() から使われる。
// toProposalsは /api/assistant/turn(統合AIチャット) と /api/meeting/ingest(会議録音) の
// 両方が通る共通経路なので、ここが両画面のReviewCardの確認表示を決める。
// 設計方針: サーバーは断定せず候補を出すだけ（勝手にマージしない）。

const roster = [
  { id: 'c1', name: '渡辺 健一' },
  { id: 'c2', name: '田中' },
  { id: 'c3', name: '佐藤 花子' },
  { id: 'c4', name: '鈴木 一郎' },
];

test.describe('canonicalName: 比較用の正規形', () => {
  test('敬称・空白・全半角の違いを吸収する', () => {
    expect(canonicalName('田中 太郎さん')).toBe(canonicalName('田中太郎'));
  });

  test('カタカナとひらがなを同一視する（音声入力の揺れ）', () => {
    expect(canonicalName('タナカ')).toBe(canonicalName('たなか'));
  });

  test('異体字を代表字に寄せる（渡邊→渡辺・齋藤→斉藤・髙橋→高橋）', () => {
    expect(canonicalName('渡邉')).toBe(canonicalName('渡辺'));
    expect(canonicalName('齋藤')).toBe(canonicalName('斉藤'));
    expect(canonicalName('髙橋')).toBe(canonicalName('高橋'));
  });
});

test.describe('nameSimilarity: 同一人物らしさのスコア', () => {
  test('正規化して同じなら1.0', () => {
    expect(nameSimilarity('渡辺健一', '渡邊 健一さん')).toBe(1);
  });

  test('姓のみとフルネームは高スコア（同一人物の可能性）', () => {
    expect(nameSimilarity('田中', '田中太郎')).toBeGreaterThanOrEqual(0.8);
  });

  test('無関係な名前は低スコア', () => {
    expect(nameSimilarity('田中太郎', '鈴木一郎')).toBeLessThan(0.7);
  });

  test('1文字の違いしかない別姓は誤検知しうるが、閾値未満に留める姓長のとき', () => {
    // 「佐藤」と「佐々木」は別人。包含関係にも無いので閾値未満であること。
    expect(nameSimilarity('佐藤', '佐々木')).toBeLessThan(0.7);
  });
});

test.describe('findSimilarNames: 確認カードに出す候補', () => {
  test('異体字の揺れを候補に出す（渡邊健一 → 既存の渡辺健一）', () => {
    const hits = findSimilarNames('渡邊 健一', roster);
    expect(hits.map((h) => h.id)).toContain('c1');
  });

  test('カタカナ入力を候補に出す（サトウハナコ → 既存の佐藤花子ではなく読み一致はしないが、揺れの主眼は漢字）', () => {
    // カナ→漢字の変換は行わない（過剰な推測をしない設計）。候補ゼロで良い。
    expect(findSimilarNames('サトウハナコ', roster)).toHaveLength(0);
  });

  test('姓だけの発話を既存フルネームの候補に出す（鈴木 → 鈴木一郎）', () => {
    const hits = findSimilarNames('鈴木', roster);
    expect(hits.map((h) => h.id)).toContain('c4');
  });

  test('正規化して完全一致するものは候補に出さない（既存へ寄せる処理が別にあるため）', () => {
    expect(findSimilarNames('田中さん', roster).map((h) => h.id)).not.toContain('c2');
  });

  test('無関係な新規の人は候補ゼロ（余計な確認を出さない）', () => {
    expect(findSimilarNames('山本 次郎', roster)).toHaveLength(0);
  });

  test('候補はスコア降順で最大3件', () => {
    const many = [
      { id: 'a', name: '中村' },
      { id: 'b', name: '中村一郎' },
      { id: 'c', name: '中村二郎' },
      { id: 'd', name: '中村三郎' },
      { id: 'e', name: '中村四郎' },
    ];
    const hits = findSimilarNames('中村太郎', many);
    expect(hits.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });
});
