// プラン選択 → Stripe Checkout（§11）。サインアップ後にここへ来る。
// チャネル割引は ?code=LL2026 のように埋め込まれたコードを引き継ぐ。
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { PlanPicker } from './PlanPicker';

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

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px' }}>
      <h1>プランを選ぶ</h1>
      <p style={{ color: '#6b6358' }}>14日間無料。トライアル終了後に自動課金されます。</p>
      {code && <p style={{ color: 'var(--color-primary)' }}>割引コード適用中: {code}</p>}
      <PlanPicker code={code ?? null} />
    </main>
  );
}
