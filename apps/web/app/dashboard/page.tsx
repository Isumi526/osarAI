// Dashboard（リーダー集約ビュー・§F-05）。leader が同組織メンバーの主要指標
// （顧客数/活動量/最終活動）を一覧→メンバーへドリルダウン。閲覧のみ。
// RLS: leader は同組織の customers/interactions/profiles を参照可（0002_rls）。
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { WelcomeBanner } from './WelcomeBanner';

export const dynamic = 'force-dynamic';

interface MemberRow {
  id: string;
  name: string;
  role: string;
  customerCount: number;
  activityCount: number;
  lastActivity: string | null;
}

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

  if (profile?.role !== 'leader') {
    return (
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
        <WelcomeBanner />
        <h1>ダッシュボード</h1>
        <p style={{ color: '#6b6358' }}>
          リーダー集約ビューは leader ロールのみ閲覧できます（あなたは {profile?.role ?? '—'}）。
        </p>
      </main>
    );
  }

  // 同組織のメンバー・顧客・活動をまとめて取得（RLSでleaderは同組織全体が見える）
  const [{ data: members }, { data: customers }, { data: interactions }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, display_name, role')
      .eq('org_id', profile.org_id)
      .returns<{ id: string; display_name: string | null; role: string }[]>(),
    supabase.from('customers').select('owner_id').returns<{ owner_id: string }[]>(),
    supabase
      .from('interactions')
      .select('author_id, created_at')
      .returns<{ author_id: string; created_at: string }[]>(),
  ]);

  const customerCountByOwner = new Map<string, number>();
  for (const c of customers ?? []) {
    customerCountByOwner.set(c.owner_id, (customerCountByOwner.get(c.owner_id) ?? 0) + 1);
  }
  const activityByAuthor = new Map<string, { count: number; last: string | null }>();
  for (const ix of interactions ?? []) {
    const cur = activityByAuthor.get(ix.author_id) ?? { count: 0, last: null };
    cur.count += 1;
    if (!cur.last || ix.created_at > cur.last) cur.last = ix.created_at;
    activityByAuthor.set(ix.author_id, cur);
  }

  const rows: MemberRow[] = (members ?? [])
    .map((m) => {
      const act = activityByAuthor.get(m.id);
      return {
        id: m.id,
        name: m.display_name ?? '(名前未設定)',
        role: m.role,
        customerCount: customerCountByOwner.get(m.id) ?? 0,
        activityCount: act?.count ?? 0,
        lastActivity: act?.last ?? null,
      };
    })
    .sort((a, b) => b.activityCount - a.activityCount);

  const totalCustomers = customers?.length ?? 0;
  const totalActivity = interactions?.length ?? 0;

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
      <WelcomeBanner />
      <h1 style={{ marginBottom: 4 }}>リーダーダッシュボード</h1>
      <p style={{ color: '#6b6358', marginTop: 0 }}>
        {profile.display_name ?? user.email} さん ・ メンバー{rows.length}名 ・ 顧客{totalCustomers}件 ・
        活動{totalActivity}件
      </p>
      <p style={{ marginTop: 8 }}>
        <Link href="/dashboard/products" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
          代理店商品リストを管理する →
        </Link>
      </p>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 24 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--color-border)' }}>
            <th style={th}>メンバー</th>
            <th style={th}>役割</th>
            <th style={{ ...th, textAlign: 'right' }}>顧客数</th>
            <th style={{ ...th, textAlign: 'right' }}>活動量</th>
            <th style={th}>最終活動</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ ...td, color: '#9a9183' }}>
                メンバーがいません。
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #efeae0' }}>
                <td style={td}>
                  <Link href={`/dashboard/${r.id}`} style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                    {r.name}
                  </Link>
                </td>
                <td style={td}>{r.role === 'leader' ? 'リーダー' : 'メンバー'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.customerCount}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.activityCount}</td>
                <td style={td}>
                  {r.lastActivity ? new Date(r.lastActivity).toLocaleDateString('ja-JP') : '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p style={{ color: '#9a9183', fontSize: 13, marginTop: 16 }}>
        ※閲覧のみ。メンバー名をクリックすると担当顧客の一覧を確認できます。
      </p>
    </main>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 13, color: '#6b6358' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14 };
