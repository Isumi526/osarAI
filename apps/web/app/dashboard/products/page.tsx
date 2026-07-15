// 代理店(leader)が商品リストを管理する画面（議事録『review』回答A）。
// 「代理店管理者ロール」は既存のprofiles.role='leader'を流用（新規ロール階層は追加しない）。
// 紹介ユーザー(member)側のインポート導線はモバイルアプリのマイページ「扱っている商品」。
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

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, org_id')
    .eq('id', user.id)
    .single<{ role: string; org_id: string }>();

  if (profile?.role !== 'leader') {
    return (
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
        <h1>代理店商品リスト</h1>
        <p style={{ color: '#6b6358' }}>この画面は leader ロールのみ利用できます。</p>
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
        ここで作成した商品リストは、同じ組織のメンバーがアプリのマイページから自分の「扱っている商品」にインポートできます。
      </p>
      <AgencyProductsManager initialProducts={products ?? []} />
    </main>
  );
}
