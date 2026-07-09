// 課金状況の確認＋再決済導線（A3対策）。§16「未契約/解約は機能制限」の自己解決先。
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { planDef } from '@osarai/shared';
import { BillingPortalButton } from './BillingPortalButton';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  trialing: 'トライアル中',
  active: '契約中',
  past_due: '支払い失敗（要対応）',
  canceled: '解約済み',
  incomplete: '未完了',
  incomplete_expired: '期限切れ',
  unpaid: '未払い',
};

export default async function BillingPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan, status, stripe_customer_id, current_period_end, trial_end')
    .eq('user_id', user.id)
    .maybeSingle<{
      plan: string | null;
      status: string | null;
      stripe_customer_id: string | null;
      current_period_end: string | null;
      trial_end: string | null;
    }>();

  const status = sub?.status ?? null;
  const def = planDef(sub?.plan ?? null);
  const needsAttention = status === 'past_due' || status === 'unpaid' || status === 'incomplete_expired';

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '48px 24px' }}>
      <h1>お支払い状況</h1>
      {!sub ? (
        <p>契約情報がありません。まだプランに登録されていません。</p>
      ) : (
        <>
          <p>
            プラン: {def?.name ?? sub.plan ?? '不明'} ／ 状態:{' '}
            {status ? (STATUS_LABEL[status] ?? status) : '不明'}
          </p>
          {needsAttention && (
            <div style={{ background: '#fdecea', border: '1px solid #f5c6c0', borderRadius: 8, padding: 16, margin: '16px 0' }}>
              <p style={{ color: '#c0392b', margin: 0, fontWeight: 600 }}>
                自動課金に失敗しています。お支払い方法を更新してください。
              </p>
            </div>
          )}
          {status === 'trialing' && sub.trial_end && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
              トライアル期間中（{new Date(sub.trial_end).toLocaleDateString('ja-JP')}まで）にキャンセルすれば料金はかかりません。
            </p>
          )}
          {sub.stripe_customer_id && <BillingPortalButton />}
        </>
      )}
    </main>
  );
}
