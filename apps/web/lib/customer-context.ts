// 顧客データをAIプロンプト用のテキストにまとめる共通ヘルパー。
// /api/advice（AI戦略相談）と /api/cron/apo-strategy（アポ当日事前戦略提案）で共用。
import type { ChatScope, AiSummary } from '@osarai/shared';

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
      .select('name, temperature, needs, last_met_at, custom_fields')
      .eq('id', customerId)
      .maybeSingle();
    if (!c) return 'データなし';
    const { data: ix } = await supabase
      .from('interactions')
      .select('source, met_at, ai_summary, raw_text')
      .eq('customer_id', customerId)
      .order('met_at', { ascending: false, nullsFirst: false })
      .limit(10);
    const timeline = (ix ?? [])
      .map((r) => {
        const s = r.ai_summary as AiSummary | null;
        const when = r.met_at ? new Date(r.met_at).toLocaleDateString('ja-JP') : '日付不明';
        const bodyText = s?.points?.length ? s.points.join('、') : (r.raw_text ?? '').slice(0, 120);
        const next = s?.next_actions?.length ? ` / 次: ${s.next_actions.join('、')}` : '';
        return `- ${when}: ${bodyText}${next}`;
      })
      .join('\n');
    return [
      `名前: ${c.name}`,
      `温度感: ${c.temperature ?? '未設定'}`,
      `ニーズ: ${c.needs ?? '未把握'}`,
      `最終接触: ${c.last_met_at ? new Date(c.last_met_at).toLocaleDateString('ja-JP') : '未記録'}`,
      ...formatCustomerFieldLines(c.custom_fields as Record<string, unknown> | null),
      `履歴:\n${timeline || '（履歴なし）'}`,
    ].join('\n');
  }

  // scope=all: 顧客一覧サマリ（RLS で自分の担当分のみ）
  const { data: customers } = await supabase
    .from('customers')
    .select('name, temperature, needs, last_met_at, status')
    .eq('status', 'active')
    .order('last_met_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (!customers || customers.length === 0) return 'データなし（まだ顧客が登録されていません）';
  return customers
    .map((c) => {
      const when = c.last_met_at ? new Date(c.last_met_at).toLocaleDateString('ja-JP') : '未記録';
      return `- ${c.name}（温度: ${c.temperature ?? '?'} / ニーズ: ${c.needs ?? '未把握'} / 最終接触: ${when}）`;
    })
    .join('\n');
}

// customers.custom_fields内の商品/年齢/性別（おさらい対話でのAI抽出先。0007_profile_user_context.sql
// のuserProfile(products/age/gender)と同じパターンを顧客側にも適用）。
function formatCustomerFieldLines(customFields: Record<string, unknown> | null): string[] {
  if (!customFields) return [];
  const lines: string[] = [];
  const age = customFields.age;
  if (typeof age === 'string' && age.trim()) lines.push(`年齢: ${age}`);
  const gender = customFields.gender;
  if (typeof gender === 'string' && gender.trim()) lines.push(`性別: ${gender}`);
  const products = customFields.products;
  if (Array.isArray(products)) {
    const productLines = products.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (productLines.length > 0) lines.push(`扱っている商品: ${productLines.join('、')}`);
  } else if (typeof products === 'string' && products.trim()) {
    lines.push(`扱っている商品: ${products}`);
  }
  return lines;
}

const USER_PROFILE_LABEL: Record<string, string> = {
  age: '年齢',
  gender: '性別',
  background: '経歴',
  job: '仕事',
  goal: '目標',
};

export function formatUserProfile(userProfile: Record<string, unknown> | null): string | undefined {
  if (!userProfile) return undefined;
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

  // 「自分をおさらいする」対話で蓄積した自由記述の気づき（notes: string[]）
  const notes = userProfile.notes;
  if (Array.isArray(notes) && notes.length > 0) {
    lines.push(`本人との対話から蓄積した気づき:\n${notes.map((n) => `- ${n}`).join('\n')}`);
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}
