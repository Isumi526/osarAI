// Dashboard（リーダー集約ビュー）— フェーズ3では認証ガード＋プロフィール表示まで。
// 集約ビュー本体（配下メンバー一覧/指標）はフェーズ9（§F-05）で実装。
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';

export default async function DashboardPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, display_name, org_id')
    .eq('id', user.id)
    .single<{ role: string; display_name: string | null; org_id: string }>();

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
      <h1>ダッシュボード</h1>
      <p>
        ようこそ、{profile?.display_name ?? user.email} さん（role: {profile?.role ?? '—'}）
      </p>
      {profile?.role === 'leader' ? (
        <p>配下メンバーの集約ビューはフェーズ9で実装。</p>
      ) : (
        <p style={{ color: '#6b6358' }}>
          ※リーダー集約ビューは leader ロールのみ。あなたは member です。
        </p>
      )}
    </main>
  );
}
