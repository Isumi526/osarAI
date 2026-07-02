// メンバー・ドリルダウン（§F-05）。leader が配下メンバーの担当顧客一覧を閲覧（読み取りのみ）。
// RLS: leader は同組織の profiles/customers を参照可。他組織は current_org_id() で遮断。
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const TEMP_LABEL: Record<string, string> = { hot: '🔥 hot', warm: '☀️ warm', cold: '❄️ cold' };

export default async function MemberPage({ params }: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await params;
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('profiles')
    .select('role, org_id')
    .eq('id', user.id)
    .single<{ role: string; org_id: string }>();
  if (me?.role !== 'leader') {
    return (
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
        <p style={{ color: '#6b6358' }}>リーダーのみ閲覧できます。</p>
      </main>
    );
  }

  // 同組織のメンバーか確認（RLS で org 外は取得できない）
  const { data: member } = await supabase
    .from('profiles')
    .select('display_name, role, org_id')
    .eq('id', memberId)
    .maybeSingle<{ display_name: string | null; role: string; org_id: string }>();
  if (!member || member.org_id !== me.org_id) {
    return (
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
        <Link href="/dashboard">← ダッシュボード</Link>
        <p style={{ color: '#6b6358', marginTop: 16 }}>メンバーが見つかりません。</p>
      </main>
    );
  }

  const { data: customers } = await supabase
    .from('customers')
    .select('id, name, temperature, needs, status, last_met_at')
    .eq('owner_id', memberId)
    .order('last_met_at', { ascending: false, nullsFirst: false })
    .returns<
      {
        id: string;
        name: string;
        temperature: string | null;
        needs: string | null;
        status: string;
        last_met_at: string | null;
      }[]
    >();

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
      <Link href="/dashboard">← ダッシュボード</Link>
      <h1 style={{ marginBottom: 4, marginTop: 12 }}>{member.display_name ?? '(名前未設定)'}</h1>
      <p style={{ color: '#6b6358', marginTop: 0 }}>担当顧客 {customers?.length ?? 0} 件（閲覧のみ）</p>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 24 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #e7e1d6' }}>
            <th style={th}>顧客</th>
            <th style={th}>温度感</th>
            <th style={th}>ニーズ</th>
            <th style={th}>状態</th>
            <th style={th}>最終接触</th>
          </tr>
        </thead>
        <tbody>
          {!customers || customers.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ ...td, color: '#9a9183' }}>
                担当顧客がありません。
              </td>
            </tr>
          ) : (
            customers.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid #efeae0' }}>
                <td style={td}>{c.name}</td>
                <td style={td}>{c.temperature ? (TEMP_LABEL[c.temperature] ?? c.temperature) : '—'}</td>
                <td style={{ ...td, color: '#6b6358' }}>{c.needs ?? '—'}</td>
                <td style={td}>{c.status === 'active' ? '対応中' : 'アーカイブ'}</td>
                <td style={td}>
                  {c.last_met_at ? new Date(c.last_met_at).toLocaleDateString('ja-JP') : '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </main>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 13, color: '#6b6358' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14 };
