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

const USER_PROFILE_LABEL: Record<string, string> = {
  age: '年齢',
  gender: '性別',
  background: '経歴',
  job: '仕事',
  products: '扱っている商品',
  goal: '目標',
};

export function formatUserProfile(userProfile: Record<string, string> | null): string | undefined {
  if (!userProfile) return undefined;
  const lines = Object.entries(userProfile)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${USER_PROFILE_LABEL[k] ?? k}: ${v}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}
