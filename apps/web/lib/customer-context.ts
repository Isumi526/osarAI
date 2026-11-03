// 顧客データをAIプロンプト用のテキストにまとめる共通ヘルパー。
// /api/advice（AI戦略相談）と /api/cron/apo-strategy（アポ当日事前戦略提案）で共用。
// 2026-11-03（0035）: つながりのメモ（customers.profile_notes）・その回の要約（interactions.summary）・
// 自分のメモ（profiles.profile_text）を先に読み、空なら旧項目（needs / custom_fields / ai_summary.points 等 /
// user_profile.notes）から同じ書式に畳んで使う。
import { customerMemo, interactionSummaryText, personWantsToMeet, selfMemo, type ChatScope, type AiSummary } from '@osarai/shared';

export type SB = import('@supabase/supabase-js').SupabaseClient<
  import('@osarai/shared/database.types').Database
>;

export async function buildContext(
  supabase: SB,
  scope: ChatScope,
  customerId: string | null,
): Promise<string> {
  if (scope === 'customer' && customerId) {
    const { data: c } = await supabase
      .from('customers')
      .select('name, temperature, profile_notes, needs, last_met_at, custom_fields')
      .eq('id', customerId)
      .maybeSingle();
    if (!c) return 'データなし';
    const { data: ix } = await supabase
      .from('interactions')
      .select('source, met_at, summary, ai_summary, raw_text')
      .eq('customer_id', customerId)
      .order('met_at', { ascending: false, nullsFirst: false })
      .limit(10);
    const timeline = (ix ?? [])
      .map((r, i) => {
        const s = r.ai_summary as AiSummary | null;
        const when = r.met_at ? new Date(r.met_at).toLocaleDateString('ja-JP') : '日付不明';
        // その回の要約（新しい列 summary、無ければ旧 points/needs/next_actions を畳んだ文章）
        const summary = interactionSummaryText(r);
        // 会議録音の議事録があればそれを優先（直近3件は全文、それ以前は冒頭のみ）。
        // AI相談が「前回どんな話をしたか」を踏まえて答えられるようにする（T7c）。
        if (s?.minutes) {
          const body = i < 3 ? s.minutes : s.minutes.slice(0, 300) + (s.minutes.length > 300 ? '…' : '');
          const memo = summary ? `\n    メモ: ${summary.replace(/\n/g, ' / ')}` : '';
          return `- ${when}（会議の議事録）:\n${body.replace(/^/gm, '    ')}${memo}`;
        }
        const bodyText = summary ? summary.replace(/\n/g, ' / ') : (r.raw_text ?? '').slice(0, 120);
        return `- ${when}: ${bodyText}`;
      })
      .join('\n');
    const memo = customerMemo(c);
    const wants = personWantsToMeet({ custom_fields: c.custom_fields });
    return [
      `名前: ${c.name}`,
      `温度感: ${c.temperature ?? '未設定'}`,
      `最終接触: ${c.last_met_at ? new Date(c.last_met_at).toLocaleDateString('ja-JP') : '未記録'}`,
      `この人のメモ:\n${memo || '（未記入）'}`,
      ...(wants.length ? [`つながりたい人: ${wants.join('、')}`] : []),
      `履歴:\n${timeline || '（履歴なし）'}`,
    ].join('\n');
  }

  // scope=all: 顧客一覧サマリ（RLS で自分の担当分のみ）
  const { data: customers } = await supabase
    .from('customers')
    .select('name, temperature, profile_notes, needs, custom_fields, last_met_at, status')
    .eq('status', 'active')
    .order('last_met_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (!customers || customers.length === 0) return 'データなし（まだ顧客が登録されていません）';
  return customers
    .map((c) => {
      const when = c.last_met_at ? new Date(c.last_met_at).toLocaleDateString('ja-JP') : '未記録';
      return `- ${c.name}（温度: ${c.temperature ?? '?'} / メモ: ${memoHead(customerMemo(c)) || '未記入'} / 最終接触: ${when}）`;
    })
    .join('\n');
}

/** メモを名簿・一覧向けに1行へ縮める（改行を「 / 」にし、長ければ切る）。 */
export function memoHead(memo: string, max = 80): string {
  const one = memo.replace(/\s*\n\s*/g, ' / ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

const USER_PROFILE_LABEL: Record<string, string> = {
  age: '年齢',
  gender: '性別',
  background: '経歴',
  job: '仕事',
  goal: '目標',
};

/**
 * 自分のプロフィールをAI向けに整形する。profileText（profiles.profile_text・0035）を渡すと
 * 「自分のメモ」として使い、渡さない（undefined）・null なら旧 user_profile.notes を読む。
 */
export function formatUserProfile(
  userProfile: Record<string, unknown> | null,
  profileText?: string | null,
): string | undefined {
  if (!userProfile && profileText == null) return undefined;
  userProfile = userProfile ?? {};
  const lines = Object.entries(userProfile)
    .filter(([k, v]) => k !== 'notes' && k !== 'goals' && k !== 'products' && typeof v === 'string' && v.trim())
    .map(([k, v]) => `${USER_PROFILE_LABEL[k] ?? k}: ${v as string}`);

  // 目標（goals: {text, by}[]）は「目標内容（いつまでに）」の形で複数行に整形する。
  const goals = userProfile.goals;
  if (Array.isArray(goals)) {
    const goalLines = goals
      .filter((g): g is { text: string; by?: string } => !!g && typeof g.text === 'string' && g.text.trim())
      .map((g) => (g.by?.trim() ? `- ${g.text}（${g.by}）` : `- ${g.text}`));
    if (goalLines.length > 0) lines.push(`目標:\n${goalLines.join('\n')}`);
  }

  // 扱っている商品（products: {name, price, appeal, target}[]。目標と同じカラム化パターン。
  // 購入条件(condition)は廃止し、魅力・概要/ターゲット・届けたい相手に置き換えた(議事録要望。
  // ターゲットと届けたい相手は当初別項目だったが、/review指摘で1項目(target)に統合)）。
  const products = userProfile.products;
  if (Array.isArray(products)) {
    const productLines = products
      .filter(
        (p): p is { name: string; price?: string; appeal?: string; target?: string } =>
          !!p && typeof p.name === 'string' && p.name.trim().length > 0,
      )
      .map((p) => {
        const parts = [p.name];
        if (p.price?.trim()) parts.push(p.price);
        if (p.appeal?.trim()) parts.push(`魅力: ${p.appeal}`);
        if (p.target?.trim()) parts.push(`ターゲット・届けたい相手: ${p.target}`);
        return `- ${parts.join(' / ')}`;
      });
    if (productLines.length > 0) lines.push(`扱っている商品:\n${productLines.join('\n')}`);
  } else if (typeof products === 'string' && products.trim()) {
    // 旧: 単一自由記述文字列からの移行期間の後方互換。
    lines.push(`扱っている商品: ${products}`);
  }

  // 自分についてのメモ（自由記述・profile_text）。無ければ旧「自分をおさらい」の気づき（notes: string[]）
  const memo = selfMemo({ profile_text: profileText, user_profile: userProfile });
  if (memo) {
    lines.push(`本人についてのメモ:\n${memo}`);
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * 発話に登録済みの相手の名前が出ているか。「村田涼太」を「村田さん」と呼ぶことが多いので、
 * フルネーム一致に加えて姓（空白の前、無ければ先頭2文字）＋敬称でも拾う。
 */
export function isNameMentioned(text: string, name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  if (!n || !text) return false;
  const compactText = text.replace(/[\s　]/g, '');
  const full = n.replace(/[\s　]/g, '');
  if (full.length >= 2 && compactText.includes(full)) return true;
  const family = /[\s　]/.test(n) ? n.split(/[\s　]/)[0]! : n.slice(0, 2);
  if (family.length < 2) return false;
  return new RegExp(`${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(さん|様|さま|氏|くん|ちゃん)`).test(compactText);
}
