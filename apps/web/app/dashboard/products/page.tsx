// 「リーダー」課金プラン契約者が商品リストを管理する画面
// （【要設計判断】代理店/リーダー再設計・回答A）。
// 旧: profiles.role='leader'の流用だったが、正しくは「リーダー」は役割フラグではなく
// 課金プラン(subscriptions.plan='leader')。招待ユーザー(member)側のインポート導線は
// モバイルアプリのマイページ「扱っている商品」。
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { AgencyProductsManager } from './AgencyProductsManager';

export const dynamic = 'force-dynamic';

export default async function AgencyProductsPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan, status')
    .eq('user_id', user.id)
    .maybeSingle<{ plan: string | null; status: string | null }>();
  const isActiveLeader = sub?.plan === 'leader' && (sub.status === 'trialing' || sub.status === 'active');

  if (!isActiveLeader) {
    return (
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
        <h1>代理店商品リスト</h1>
        <p style={{ color: '#6b6358' }}>この画面は有効な Leader プラン契約者のみ利用できます。</p>
      </main>
    );
  }

  const { data: products } = await supabase
    .from('agency_products')
    .select('id, name, price, appeal, target')
    .order('created_at', { ascending: true });

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
      <Link href="/dashboard" style={{ color: 'var(--color-primary)' }}>
        ← ダッシュボード
      </Link>
      <h1 style={{ marginBottom: 4 }}>代理店商品リスト</h1>
      <p style={{ color: '#6b6358', marginTop: 0 }}>
        ここで作成した商品リストは、あなたの紹介で登録したメンバーがアプリのマイページから自分の「扱っている商品」にインポートできます。
      </p>
      <AgencyProductsManager initialProducts={products ?? []} />
    </main>
  );
}
