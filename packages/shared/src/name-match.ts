// 人名の表記揺れ検知（音声入力で「渡辺/渡邊」「タナカ/田中」等が別人として重複登録されるのを防ぐ）。
// 完全一致による寄せは commitProposals 側で既に行っているため、ここが担うのは
// 「完全一致しないが同一人物かもしれない」候補の抽出＝ユーザーに確認を出すための材料。
// 断定はしない（勝手にマージしない）のが設計方針。

/** 敬称・空白・全半角・大小文字を落とした基本正規化（既存の寄せロジックと同一の規則）。 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/(さん|様|さま|氏|くん|ちゃん)$/u, '')
    .toLowerCase();
}

/** カタカナ→ひらがな（音声入力の「タナカ」と手入力の「たなか」を同一視する）。 */
function kanaToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// 日本人の姓で頻出する異体字のみを対象にする（網羅は狙わない＝過剰実装を避ける）。
const VARIANTS: Record<string, string> = {
  邊: '辺', 邉: '辺',
  齋: '斉', 齊: '斉', 斎: '斉',
  髙: '高',
  﨑: '崎',
  濵: '浜',
  澤: '沢',
  嶋: '島',
  冨: '富',
  籐: '藤',
  桒: '桑',
  栁: '柳',
};

/** 異体字を代表字へ寄せる。 */
function foldVariants(s: string): string {
  return s.replace(/[邊邉齋齊斎髙﨑濵澤嶋冨籐桒栁]/g, (c) => VARIANTS[c] ?? c);
}

/** 比較用の正規形（敬称除去＋カナ統一＋異体字統一）。 */
export function canonicalName(name: string): string {
  return foldVariants(kanaToHira(normalizeName(name)));
}

/** レーベンシュタイン距離。 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * 2つの名前の類似度（0..1）。1.0 は「正規化すると完全に同じ」。
 * 姓だけ vs フルネームのような包含関係も、同一人物の可能性として高めに評価する。
 */
export function nameSimilarity(a: string, b: string): number {
  const x = canonicalName(a);
  const y = canonicalName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // 「田中」と「田中太郎」のような包含。1文字の姓は誤検知が多いので2文字以上に限る。
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (shorter.length >= 2 && longer.startsWith(shorter)) return 0.85;
  const dist = levenshtein(x, y);
  return 1 - dist / Math.max(x.length, y.length);
}

export interface SimilarNameCandidate {
  id: string;
  name: string;
  score: number;
}

/**
 * 既存つながりの中から「同一人物かもしれない」候補を返す。
 * 正規化して完全一致するものは呼び出し側が既に既存へ寄せているため、ここでは除外する
 * （確認を出す意味が無いものを出さない）。
 */
export function findSimilarNames(
  name: string,
  customers: { id: string; name: string }[],
  opts: { threshold?: number; limit?: number } = {},
): SimilarNameCandidate[] {
  const threshold = opts.threshold ?? 0.7;
  const limit = opts.limit ?? 3;
  const target = normalizeName(name);
  if (!target) return [];
  return customers
    .filter((c) => normalizeName(c.name) !== target) // 完全一致は既存寄せ済み
    .map((c) => ({ id: c.id, name: c.name, score: nameSimilarity(name, c.name) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
