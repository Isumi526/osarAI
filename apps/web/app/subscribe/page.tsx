// プラン選択 → Stripe Checkout（§11）。サインアップ後にここへ来る。
// チャネル割引は ?code=LL2026 のように埋め込まれたコードを引き継ぐ。
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';
import { PlanPicker } from './PlanPicker';

// checkout route(A4対策)と同じ検証: コードは特定プラン向け(Coupon.metadata.plan)。
// ここではphase1のStandard固定表示のためstandard向けクーポンのみ解決する。
async function resolveAmountOff(code: string): Promise<number | null> {
  try {
    const stripe = getStripe();
    const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    const pc = found.data[0];
    if (!pc || pc.coupon.metadata?.plan !== 'standard') return null;
    return pc.coupon.amount_off ?? null;
  } catch {
    return null;
  }
}

export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const amountOff = code ? await resolveAmountOff(code) : null;

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px' }}>
      <h1>プランを選ぶ</h1>
      <p style={{ color: '#6b6358' }}>14日間無料。トライアル終了後に自動課金されます。</p>
      <p
        style={{
          fontSize: 13,
          color: 'var(--color-text-muted)',
          background: 'var(--color-primary-light)',
          border: '1px solid var(--color-primary-border)',
          borderRadius: 8,
          padding: '10px 14px',
          margin: '12px 0 16px',
        }}
      >
        osarAIは現在β版として提供しています。不具合や使いづらい点が残っている場合がありますので、ご了承ください。
      </p>
      {code && (
        <p style={{ color: amountOff ? 'var(--color-success)' : '#c0392b' }}>
          {amountOff
            ? `割引コード「${code}」適用中（¥${amountOff.toLocaleString()}引き）`
            : `割引コード「${code}」は無効です`}
        </p>
      )}
      <PlanPicker code={code ?? null} amountOff={amountOff} />
    </main>
  );
}
