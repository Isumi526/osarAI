// 代理店(leader)が紹介コードを管理する画面（議事録『review』回答A）。
// 【重要】ここではStripe側のPromotion Code発行は行わない（記録・使用状況追跡のみ。
// 実際のStripe発行は運営者がCLIで行う運用を維持する。CLAUDE.md §0 B-1 参照）。
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { ReferralCodesManager } from './ReferralCodesManager';

export const dynamic = 'force-dynamic';

export default async function ReferralCodesPage() {
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
        <h1>紹介コード管理</h1>
        <p style={{ color: '#6b6358' }}>この画面は leader ロールのみ利用できます。</p>
      </main>
    );
  }

  const codesQuery = supabase
    .from('referral_codes')
    .select('id, code, label, created_at')
    .order('created_at', { ascending: true })
    .returns<{ id: string; code: string; label: string | null; created_at: string }[]>();
  const membersQuery = supabase
    .from('profiles')
    .select('channel_code')
    .eq('org_id', profile.org_id)
    .returns<{ channel_code: string | null }[]>();
  const [{ data: codes }, { data: members }] = await Promise.all([codesQuery, membersQuery]);
  const countByCode = new Map<string, number>();
  for (const m of members ?? []) {
    if (m.channel_code) countByCode.set(m.channel_code, (countByCode.get(m.channel_code) ?? 0) + 1);
  }
  const initialCodes = (codes ?? []).map((c) => ({ ...c, signupCount: countByCode.get(c.code) ?? 0 }));

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
      <Link href="/dashboard" style={{ color: 'var(--color-primary)' }}>
        ← ダッシュボード
      </Link>
      <h1 style={{ marginBottom: 4 }}>紹介コード管理</h1>
      <p style={{ color: '#6b6358', marginTop: 0 }}>
        ここではコードの記録と、そのコード経由の登録者数を確認できます。実際の割引コードのStripe発行は運営者が行います。
      </p>
      <ReferralCodesManager initialCodes={initialCodes} />
    </main>
  );
}
