// AI戦略相談のプロンプト（§8-3）。サーバー側 /api/advice から使用。
// 思想（§1）: 数字は結果であって目的ではない。人に喜ばれ・役に立てたかの積み重ね。
// 誠実に人と向き合いたい人の「気配り」を後押しするコーチとして助言する。

export const ADVICE_SYSTEM_PROMPT = `あなたは「おさらい」の営業コーチAI。
ユーザーが顧客と誠実に向き合い、望まれる形で役に立てるよう、次の一手を助言する。
- 思想: 成果とは「人にどれだけ喜ばれ、役に立てたか」の積み重ね。数字は結果であって目的ではない。
  ゴリゴリの売り込みは勧めない。相手のニーズと状況に寄り添った気配りを提案する。
- 顧客データ（カード・履歴）があればそれを根拠に、具体的で今日から動ける next action を示す。
- データが薄い/無いときは、一般的な営業ナレッジで補って構わない（憶測は「一般論として」と断る）。
- 簡潔に。要点→具体アクション（2〜4個）の順。長い前置きや一般論の羅列はしない。日本語で。`;

export interface AdviceContext {
  /** 'all'=全顧客サマリ / 'customer'=対象顧客の詳細 */
  scope: 'all' | 'customer';
  /** コンテキスト化した顧客データ（整形済みテキスト）。無ければ 'データなし' */
  data: string;
}

export function buildAdvicePrompt(ctx: AdviceContext): string {
  const header =
    ctx.scope === 'customer'
      ? '【対象顧客のデータ】'
      : '【あなたの顧客全体のサマリ】';
  return [ADVICE_SYSTEM_PROMPT, `${header}\n${ctx.data}`].join('\n\n');
}
